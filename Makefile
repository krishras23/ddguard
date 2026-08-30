PORT        ?= 8126
DD_API_URL  ?= http://localhost:$(PORT)
PLAN        ?= fixtures/tfplan.json
DAYS        ?= 30
FORMAT_FLAG ?=
# what `run` does with ddguard's exit code; demo reports it, check propagates it
TAIL        ?= exit $$status

export PORT

.PHONY: seed mockdd demo check gate run image image-demo clean

seed:
	node mockdd/seed.js

mockdd:
	node mockdd/server.js

demo: TAIL = echo; echo "ddguard exited $$status - 1 means findings that would block a merge"
demo: run

check: FORMAT_FLAG = --format=markdown
check: run

# the real gate: a real plan against a real API, no mockdd and no fixtures
gate:
	@node ddguard/bin/ddguard.js $(PLAN) --days=$(DAYS) --format=markdown

run: seed
	@node mockdd/server.js & \
	pid=$$!; \
	trap "kill $$pid 2>/dev/null" INT TERM; \
	for _ in $$(seq 1 50); do curl -s -o /dev/null $(DD_API_URL)/health && break || sleep 0.2; done; \
	DD_API_URL=$(DD_API_URL) node ddguard/bin/ddguard.js $(PLAN) --days=$(DAYS) $(FORMAT_FLAG); \
	status=$$?; \
	kill $$pid 2>/dev/null; \
	wait $$pid 2>/dev/null; \
	$(TAIL)

image:
	docker build -t ddguard:local .

# same demo as `make demo`, through the shipped image
image-demo: image
	docker run --rm ddguard:local

clean:
	rm -rf data/fixture
