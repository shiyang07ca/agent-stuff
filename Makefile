SHELL := /bin/bash
PYTHON ?= python3
CONTROL := $(PYTHON) -m agent_control --repo "$(CURDIR)"
LEGACY_PATHS := scripts/manage.sh tests/manage_test.sh \
	config/enabled-skills.tsv config/skill-governance.tsv .generated skills

.DEFAULT_GOAL := help

.PHONY: help validate plan apply doctor audit-skills list-skills \
 vendor-plan vendor-apply test static-check check prepare update check-pi

help:
	@printf '%s\n' \
		'Usage: make <target> [VARIABLE=value]' \
		'' \
		'  prepare                           Install locked Pi and browser dependencies' \
		'  update                            Pull, prepare, check and preview (does not apply)' \
		'  validate                          Validate the hermetic repository state' \
		'  plan                              Plan runtime changes' \
		'  apply PLAN=<fingerprint>          Apply a reviewed runtime plan' \
		'  doctor                            Inspect this machine without changing it' \
		'  audit-skills                      Report advisory governance findings' \
		'  list-skills                       List selected skills and invocation policy' \
		'  vendor-plan VENDOR=<name> TARGET=<ref>' \
		'                                    Plan one explicit vendor update' \
		'  vendor-apply VENDOR=<name> TARGET=<commit> PLAN=<fingerprint>' \
		'                                    Apply one reviewed vendor update' \
		'  test                              Run control-plane and Anki tests' \
		'  check                             Run hermetic CI checks'

validate:
	$(CONTROL) validate

prepare:
	$(CONTROL) prepare

update:
	$(CONTROL) update

check-pi:
	npm --prefix pi run check

plan:
	$(CONTROL) plan

apply:
	@test -n "$(PLAN)" || { printf '%s\n' 'PLAN is required' >&2; exit 2; }
	$(CONTROL) apply "$(PLAN)"

doctor:
	$(CONTROL) doctor

audit-skills:
	$(CONTROL) audit-skills

list-skills:
	$(CONTROL) list-skills

vendor-plan:
	@test -n "$(VENDOR)" || { printf '%s\n' 'VENDOR is required' >&2; exit 2; }
	@test -n "$(TARGET)" || { printf '%s\n' 'TARGET is required' >&2; exit 2; }
	$(CONTROL) vendor plan "$(VENDOR)" "$(TARGET)"

vendor-apply:
	@test -n "$(VENDOR)" || { printf '%s\n' 'VENDOR is required' >&2; exit 2; }
	@test -n "$(TARGET)" || { printf '%s\n' 'TARGET is required' >&2; exit 2; }
	@test -n "$(PLAN)" || { printf '%s\n' 'PLAN is required' >&2; exit 2; }
	$(CONTROL) vendor apply "$(VENDOR)" "$(TARGET)" "$(PLAN)"

test:
	$(PYTHON) -m unittest discover -s tests -v
	$(PYTHON) -m unittest discover -s custom-skills/anki-card-maker/tests -v

static-check:
	@for path in $(LEGACY_PATHS); do \
		if test -e "$$path" || test -L "$$path"; then \
			printf 'Legacy control-plane path still exists: %s\n' "$$path" >&2; \
			exit 1; \
		fi; \
	done
	git diff --check

check: export HOME := /dev/null
check: export XDG_CONFIG_HOME := /dev/null
check: export GIT_CONFIG_GLOBAL := /dev/null
check: export GIT_CONFIG_SYSTEM := /dev/null
check: export GIT_CONFIG_NOSYSTEM := 1
check: export GIT_CONFIG_COUNT := 0
check: export GIT_ATTR_NOSYSTEM := 1
check: export GIT_OPTIONAL_LOCKS := 0
check: export LC_ALL := C
check: test validate static-check check-pi
