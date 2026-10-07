CC      ?= cc
CFLAGS  ?= -O2 -Wall -Wextra -std=c11 -D_POSIX_C_SOURCE=200809L
LDLIBS  := -lsqlite3 -lcrypto

jobctl: jobctl.c schema.h
	$(CC) $(CFLAGS) -o $@ jobctl.c $(LDLIBS)

# Embed ../schema.sql as a C string so the binary is self-contained.
schema.h: ../schema.sql
	{ echo 'static const char SCHEMA_SQL[] ='; \
	  sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/.*/"&\\n"/' $<; \
	  echo ';'; } > $@

clean:
	rm -f jobctl schema.h

.PHONY: clean
