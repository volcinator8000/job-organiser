/*
 * jobctl - command-line access to the encrypted Job Organiser vault.
 *
 * The vault is an SQLite database encrypted with AES-256-GCM, key derived with
 * PBKDF2-HMAC-SHA256 (format documented in python/store.py). The database is
 * decrypted into memory only; plaintext is never written to disk unless you
 * ask for it with `decrypt`.
 *
 * The password is read from $JOBVAULT_PASSWORD or prompted on the terminal.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>

#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <sqlite3.h>

#include "schema.h"

#define MAGIC       "JOBVAULT"
#define MAGIC_LEN   8
#define VERSION     1
#define SALT_LEN    16
#define IV_LEN      12
#define TAG_LEN     16
#define KEY_LEN     32
#define HDR_LEN     (MAGIC_LEN + 1 + 4 + SALT_LEN + IV_LEN)
#define ITERATIONS  600000u

typedef struct {
    unsigned char salt[SALT_LEN];
    uint32_t iterations;
    unsigned char key[KEY_LEN];
} vault_key;

typedef struct {
    const char *path;
    sqlite3 *db;
    vault_key vk;
    unsigned char *plain;   /* bytes as last loaded/saved, to detect changes */
    size_t plain_len;
} vault;

static void die(const char *fmt, const char *arg)
{
    fprintf(stderr, "jobctl: ");
    fprintf(stderr, fmt, arg);
    fputc('\n', stderr);
    exit(1);
}

/* ---------- files ---------- */

static unsigned char *read_file(const char *path, size_t *len)
{
    FILE *f = fopen(path, "rb");
    if (!f)
        return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    rewind(f);
    unsigned char *buf = malloc(n > 0 ? (size_t)n : 1);
    if (!buf || fread(buf, 1, (size_t)n, f) != (size_t)n)
        die("cannot read %s", path);
    fclose(f);
    *len = (size_t)n;
    return buf;
}

static void write_file_atomic(const char *path, const unsigned char *buf, size_t len)
{
    size_t n = strlen(path) + 5;
    char *tmp = malloc(n);
    snprintf(tmp, n, "%s.tmp", path);
    FILE *f = fopen(tmp, "wb");
    if (!f || fwrite(buf, 1, len, f) != len || fclose(f) != 0)
        die("cannot write %s", tmp);
    if (rename(tmp, path) != 0)
        die("cannot replace %s", path);
    free(tmp);
}

/* ---------- password ---------- */

static char *read_password(const char *prompt)
{
    const char *env = getenv("JOBVAULT_PASSWORD");
    if (env && *env)
        return strdup(env);

    FILE *tty = fopen("/dev/tty", "r+");
    if (!tty)
        die("%s", "no terminal; set JOBVAULT_PASSWORD");
    struct termios old, quiet;
    tcgetattr(fileno(tty), &old);
    quiet = old;
    quiet.c_lflag &= ~(tcflag_t)ECHO;
    fputs(prompt, tty);
    fflush(tty);
    tcsetattr(fileno(tty), TCSAFLUSH, &quiet);
    char buf[1024];
    char *ok = fgets(buf, sizeof buf, tty);
    tcsetattr(fileno(tty), TCSAFLUSH, &old);
    fputc('\n', tty);
    fclose(tty);
    if (!ok)
        die("%s", "no password given");
    buf[strcspn(buf, "\r\n")] = 0;
    char *pw = strdup(buf);
    OPENSSL_cleanse(buf, sizeof buf);
    return pw;
}

static void free_password(char *pw)
{
    OPENSSL_cleanse(pw, strlen(pw));
    free(pw);
}

/* ---------- crypto ---------- */

static void derive_key(const char *pw, vault_key *vk)
{
    if (!PKCS5_PBKDF2_HMAC(pw, (int)strlen(pw), vk->salt, SALT_LEN, (int)vk->iterations,
                           EVP_sha256(), KEY_LEN, vk->key))
        die("%s", "key derivation failed");
}

static void new_key(const char *pw, vault_key *vk)
{
    if (RAND_bytes(vk->salt, SALT_LEN) != 1)
        die("%s", "no randomness");
    vk->iterations = ITERATIONS;
    derive_key(pw, vk);
}

static unsigned char *seal(const unsigned char *plain, size_t len, const vault_key *vk,
                           size_t *out_len)
{
    unsigned char *out = malloc(HDR_LEN + len + TAG_LEN);
    unsigned char *p = out;
    memcpy(p, MAGIC, MAGIC_LEN); p += MAGIC_LEN;
    *p++ = VERSION;
    *p++ = (unsigned char)(vk->iterations >> 24);
    *p++ = (unsigned char)(vk->iterations >> 16);
    *p++ = (unsigned char)(vk->iterations >> 8);
    *p++ = (unsigned char)(vk->iterations);
    memcpy(p, vk->salt, SALT_LEN); p += SALT_LEN;
    unsigned char *iv = p;
    if (RAND_bytes(iv, IV_LEN) != 1)
        die("%s", "no randomness");
    p += IV_LEN;

    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    int n = 0, total = 0;
    if (!ctx
        || EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), NULL, NULL, NULL) != 1
        || EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, IV_LEN, NULL) != 1
        || EVP_EncryptInit_ex(ctx, NULL, NULL, vk->key, iv) != 1
        || EVP_EncryptUpdate(ctx, NULL, &n, out, HDR_LEN) != 1
        || EVP_EncryptUpdate(ctx, p, &n, plain, (int)len) != 1)
        die("%s", "encryption failed");
    total = n;
    if (EVP_EncryptFinal_ex(ctx, p + total, &n) != 1)
        die("%s", "encryption failed");
    total += n;
    if (EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, TAG_LEN, p + total) != 1)
        die("%s", "encryption failed");
    EVP_CIPHER_CTX_free(ctx);
    *out_len = HDR_LEN + (size_t)total + TAG_LEN;
    return out;
}

/* Returns NULL on a wrong password or tampered file. */
static unsigned char *unseal(const unsigned char *blob, size_t len, const char *pw,
                             vault_key *vk, size_t *out_len)
{
    if (len < HDR_LEN + TAG_LEN || memcmp(blob, MAGIC, MAGIC_LEN) != 0
        || blob[MAGIC_LEN] != VERSION)
        die("%s", "not a job vault (bad magic or version)");
    const unsigned char *p = blob + MAGIC_LEN + 1;
    vk->iterations = (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
    p += 4;
    memcpy(vk->salt, p, SALT_LEN); p += SALT_LEN;
    const unsigned char *iv = p; p += IV_LEN;
    derive_key(pw, vk);

    size_t ct_len = len - HDR_LEN - TAG_LEN;
    unsigned char *out = malloc(ct_len ? ct_len : 1);
    unsigned char tag[TAG_LEN];
    memcpy(tag, blob + len - TAG_LEN, TAG_LEN);

    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    int n = 0, total = 0;
    if (!ctx
        || EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), NULL, NULL, NULL) != 1
        || EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, IV_LEN, NULL) != 1
        || EVP_DecryptInit_ex(ctx, NULL, NULL, vk->key, iv) != 1
        || EVP_DecryptUpdate(ctx, NULL, &n, blob, HDR_LEN) != 1
        || EVP_DecryptUpdate(ctx, out, &n, p, (int)ct_len) != 1)
        die("%s", "decryption failed");
    total = n;
    EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, TAG_LEN, tag);
    int ok = EVP_DecryptFinal_ex(ctx, out + total, &n);
    EVP_CIPHER_CTX_free(ctx);
    if (ok != 1) {
        OPENSSL_cleanse(out, ct_len);
        free(out);
        return NULL;
    }
    *out_len = (size_t)total + (size_t)n;
    return out;
}

/* ---------- vault ---------- */

static void exec_or_die(sqlite3 *db, const char *sql)
{
    char *err = NULL;
    if (sqlite3_exec(db, sql, NULL, NULL, &err) != SQLITE_OK)
        die("sql error: %s", err);
}

static void load_plain(vault *v, const unsigned char *plain, size_t len)
{
    if (sqlite3_open(":memory:", &v->db) != SQLITE_OK)
        die("%s", "cannot open sqlite");
    if (len) {
        unsigned char *mem = sqlite3_malloc64(len);
        memcpy(mem, plain, len);
        if (sqlite3_deserialize(v->db, "main", mem, (sqlite3_int64)len, (sqlite3_int64)len,
                                SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_RESIZEABLE)
            != SQLITE_OK)
            die("%s", "vault does not contain a valid database");
    }
    exec_or_die(v->db, SCHEMA_SQL);
}

static void vault_open(vault *v, const char *path)
{
    memset(v, 0, sizeof *v);
    v->path = path;
    size_t len;
    unsigned char *blob = read_file(path, &len);
    if (!blob)
        die("cannot open %s (run `jobctl init` first)", path);
    char *pw = read_password("Vault password: ");
    v->plain = unseal(blob, len, pw, &v->vk, &v->plain_len);
    free_password(pw);
    free(blob);
    if (!v->plain)
        die("%s", "wrong password or corrupted vault");
    load_plain(v, v->plain, v->plain_len);
}

/* Re-encrypt and write only if the database bytes changed. */
static void vault_save(vault *v, int force)
{
    sqlite3_int64 n = 0;
    unsigned char *now = sqlite3_serialize(v->db, "main", &n, 0);
    if (!now)
        die("%s", "cannot serialize database");
    if (!force && (size_t)n == v->plain_len && memcmp(now, v->plain, (size_t)n) == 0) {
        sqlite3_free(now);
        return;
    }
    size_t out_len;
    unsigned char *blob = seal(now, (size_t)n, &v->vk, &out_len);
    write_file_atomic(v->path, blob, out_len);
    free(blob);
    if (v->plain) {
        OPENSSL_cleanse(v->plain, v->plain_len);
        free(v->plain);
    }
    v->plain = malloc((size_t)n);
    memcpy(v->plain, now, (size_t)n);
    v->plain_len = (size_t)n;
    OPENSSL_cleanse(now, (size_t)n);
    sqlite3_free(now);
    fprintf(stderr, "jobctl: saved %s\n", v->path);
}

static void vault_close(vault *v)
{
    sqlite3_close(v->db);
    if (v->plain) {
        OPENSSL_cleanse(v->plain, v->plain_len);
        free(v->plain);
    }
    OPENSSL_cleanse(&v->vk, sizeof v->vk);
}

/* ---------- SQL output ---------- */

static int run_sql(sqlite3 *db, const char *sql)
{
    const char *tail = sql;
    while (tail && *tail) {
        sqlite3_stmt *st = NULL;
        if (sqlite3_prepare_v2(db, tail, -1, &st, &tail) != SQLITE_OK) {
            fprintf(stderr, "error: %s\n", sqlite3_errmsg(db));
            return 1;
        }
        if (!st)
            continue;   /* whitespace or comment */
        int cols = sqlite3_column_count(st), row = 0, rc;
        while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
            if (row++ == 0) {
                for (int i = 0; i < cols; i++)
                    printf("%s%s", i ? " | " : "", sqlite3_column_name(st, i));
                putchar('\n');
            }
            for (int i = 0; i < cols; i++) {
                const unsigned char *t = sqlite3_column_text(st, i);
                printf("%s%s", i ? " | " : "", t ? (const char *)t : "NULL");
            }
            putchar('\n');
        }
        if (rc != SQLITE_DONE) {
            fprintf(stderr, "error: %s\n", sqlite3_errmsg(db));
            sqlite3_finalize(st);
            return 1;
        }
        if (cols == 0 && sqlite3_changes(db) > 0 && sqlite3_stmt_readonly(st) == 0)
            printf("(%d row%s changed)\n", sqlite3_changes(db), sqlite3_changes(db) == 1 ? "" : "s");
        sqlite3_finalize(st);
    }
    return 0;
}

/* ---------- commands ---------- */

static int cmd_init(const char *path)
{
    if (access(path, F_OK) == 0)
        die("%s already exists", path);
    char *pw = read_password("New vault password: ");
    char *again = read_password("Repeat password: ");
    if (strcmp(pw, again) != 0)
        die("%s", "passwords do not match");
    if (strlen(pw) < 10)
        die("%s", "use at least 10 characters");
    vault v = {.path = path};
    new_key(pw, &v.vk);
    free_password(pw);
    free_password(again);
    load_plain(&v, NULL, 0);
    vault_save(&v, 1);
    vault_close(&v);
    return 0;
}

static int cmd_sql(const char *path, const char *sql)
{
    vault v;
    vault_open(&v, path);
    exec_or_die(v.db, "BEGIN");
    int rc = run_sql(v.db, sql);
    exec_or_die(v.db, rc ? "ROLLBACK" : "COMMIT");
    if (!rc)
        vault_save(&v, 0);
    vault_close(&v);
    return rc;
}

static int cmd_shell(const char *path)
{
    vault v;
    vault_open(&v, path);
    fprintf(stderr, "Decrypted %s in memory. Enter SQL ending with ';'. "
                    "Changes are saved after each statement. Ctrl-D to quit.\n", path);
    char line[4096];
    size_t cap = 4096, len = 0;
    char *buf = malloc(cap);
    buf[0] = 0;
    for (;;) {
        fputs(len ? "   ...> " : "jobs> ", stderr);
        if (!fgets(line, sizeof line, stdin))
            break;
        size_t l = strlen(line);
        if (len + l + 1 > cap)
            buf = realloc(buf, cap = (len + l + 1) * 2);
        memcpy(buf + len, line, l + 1);
        len += l;
        if (sqlite3_complete(buf)) {
            if (run_sql(v.db, buf) == 0)
                vault_save(&v, 0);
            len = 0;
            buf[0] = 0;
        }
    }
    free(buf);
    vault_close(&v);
    return 0;
}

static int cmd_passwd(const char *path)
{
    vault v;
    vault_open(&v, path);
    char *pw = read_password("New password: ");
    char *again = read_password("Repeat new password: ");
    if (strcmp(pw, again) != 0)
        die("%s", "passwords do not match");
    if (strlen(pw) < 10)
        die("%s", "use at least 10 characters");
    new_key(pw, &v.vk);
    free_password(pw);
    free_password(again);
    vault_save(&v, 1);
    vault_close(&v);
    return 0;
}

static int cmd_decrypt(const char *path, const char *out)
{
    vault v;
    vault_open(&v, path);
    write_file_atomic(out, v.plain, v.plain_len);
    fprintf(stderr, "jobctl: wrote PLAINTEXT database to %s - delete it when done\n", out);
    vault_close(&v);
    return 0;
}

static int cmd_encrypt(const char *in, const char *path)
{
    if (access(path, F_OK) == 0)
        die("%s already exists", path);
    size_t len;
    unsigned char *plain = read_file(in, &len);
    if (!plain)
        die("cannot read %s", in);
    char *pw = read_password("New vault password: ");
    vault v = {.path = path};
    new_key(pw, &v.vk);
    free_password(pw);
    load_plain(&v, plain, len);
    free(plain);
    vault_save(&v, 1);
    vault_close(&v);
    return 0;
}

static int cmd_add(const char *path, int argc, char **argv)
{
    vault v;
    vault_open(&v, path);
    sqlite3_stmt *st;
    sqlite3_prepare_v2(v.db,
        "INSERT INTO applications(company, position, url, applied_on) "
        "VALUES (?1, ?2, ?3, date('now','localtime')) RETURNING id", -1, &st, NULL);
    sqlite3_bind_text(st, 1, argv[0], -1, SQLITE_STATIC);
    sqlite3_bind_text(st, 2, argv[1], -1, SQLITE_STATIC);
    if (argc > 2)
        sqlite3_bind_text(st, 3, argv[2], -1, SQLITE_STATIC);
    if (sqlite3_step(st) != SQLITE_ROW)
        die("add failed: %s", sqlite3_errmsg(v.db));
    printf("added application #%lld\n", sqlite3_column_int64(st, 0));
    sqlite3_finalize(st);
    vault_save(&v, 0);
    vault_close(&v);
    return 0;
}

static int cmd_status(const char *path, const char *id, const char *status)
{
    vault v;
    vault_open(&v, path);
    sqlite3_stmt *st;
    sqlite3_prepare_v2(v.db, "UPDATE applications SET status = ?1 WHERE id = ?2", -1, &st, NULL);
    sqlite3_bind_text(st, 1, status, -1, SQLITE_STATIC);
    sqlite3_bind_int64(st, 2, strtoll(id, NULL, 10));
    if (sqlite3_step(st) != SQLITE_DONE)
        die("update failed: %s", sqlite3_errmsg(v.db));
    sqlite3_finalize(st);
    if (sqlite3_changes(v.db) == 0)
        die("no application with id %s", id);
    vault_save(&v, 0);
    vault_close(&v);
    return 0;
}

static void usage(void)
{
    fputs("usage: jobctl COMMAND VAULT [ARGS]\n"
          "  init    VAULT                      create a new encrypted vault\n"
          "  list    VAULT                      list applications\n"
          "  due     VAULT                      follow-ups that are due\n"
          "  add     VAULT COMPANY POSITION [URL]\n"
          "  status  VAULT ID STATUS            wishlist|applied|followed_up|interviewing|\n"
          "                                     offer|accepted|rejected|ghosted|withdrawn\n"
          "  sql     VAULT \"SQL\"                run SQL (changes are re-encrypted)\n"
          "  shell   VAULT                      interactive SQL shell\n"
          "  passwd  VAULT                      change the password\n"
          "  decrypt VAULT OUT.sqlite           write a PLAINTEXT copy\n"
          "  encrypt IN.sqlite VAULT            encrypt an existing database\n"
          "Password: $JOBVAULT_PASSWORD or interactive prompt.\n", stderr);
    exit(2);
}

int main(int argc, char **argv)
{
    if (argc < 3)
        usage();
    const char *cmd = argv[1], *path = argv[2];

    if (!strcmp(cmd, "init") && argc == 3)
        return cmd_init(path);
    if (!strcmp(cmd, "list") && argc == 3)
        return cmd_sql(path, "SELECT id, company, position, status, applied_on, next_follow_up "
                             "FROM v_applications ORDER BY COALESCE(applied_on, created_at) DESC;");
    if (!strcmp(cmd, "due") && argc == 3)
        return cmd_sql(path, "SELECT id, company, position, status, next_follow_up, days_overdue, "
                             "contact_email FROM v_due_followups;");
    if (!strcmp(cmd, "add") && (argc == 5 || argc == 6))
        return cmd_add(path, argc - 3, argv + 3);
    if (!strcmp(cmd, "status") && argc == 5)
        return cmd_status(path, argv[3], argv[4]);
    if (!strcmp(cmd, "sql") && argc == 4)
        return cmd_sql(path, argv[3]);
    if (!strcmp(cmd, "shell") && argc == 3)
        return cmd_shell(path);
    if (!strcmp(cmd, "passwd") && argc == 3)
        return cmd_passwd(path);
    if (!strcmp(cmd, "decrypt") && argc == 4)
        return cmd_decrypt(path, argv[3]);
    if (!strcmp(cmd, "encrypt") && argc == 4)
        return cmd_encrypt(path, argv[3]);
    usage();
}
