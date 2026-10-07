# Top-level helpers. `make` builds the C CLI; `make serve` runs the site locally.

all: c/jobctl

c/jobctl: c/jobctl.c schema.sql
	$(MAKE) -C c

# Assemble the GitHub Pages site (same as .github/workflows/pages.yml).
site: web/* schema.sql
	rm -rf _site && cp -r web _site && cp schema.sql _site/

serve: site
	cd _site && python3 -m http.server 8000

test: c/jobctl
	./tests/roundtrip.sh

clean:
	$(MAKE) -C c clean
	rm -rf _site

.PHONY: all site serve test clean
