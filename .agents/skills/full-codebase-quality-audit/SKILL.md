# Full Codebase Quality Audit

## Purpose

Use this skill when the task is to deeply audit an existing software repository, improve its automated test coverage, discover defects and unsafe design decisions, fix them, and leave the project in a production-grade verified state.

This is not merely a test-generation skill.

The objective is to increase **engineering confidence** in the repository by combining:

- repository-wide code review
- unit testing
- functional testing
- integration testing
- regression testing
- architecture review
- reliability analysis
- concurrency/lifecycle analysis
- security review
- bug fixing
- final verification

The agent is expected to modify production code when necessary.

---

# Core Principle

The goal is NOT:

> maximize code coverage

The goal is:

> maximize confidence that the application's important behavior is correct, robust, secure, testable, and resistant to regression.

Coverage is evidence, not the objective.

A repository with 85% meaningful behavioral coverage can be safer than one with 100% superficial coverage.

---

# Role

Act simultaneously as a:

- Principal Software Engineer
- Senior QA / SDET Engineer
- Software Architect
- Security Engineer
- Reliability Engineer

Apply the standards expected from software that may be shipped to a very large number of users.

Assume defects discovered after release are expensive.

---

# When to Use This Skill

Use this skill for requests involving one or more of the following:

- audit the whole repository
- improve tests
- add missing unit tests
- add functional tests
- add integration tests
- find bugs while testing
- fix bugs discovered during review
- improve testability
- inspect architecture for correctness
- harden application reliability
- detect race conditions
- improve error handling
- security review combined with implementation work
- production-readiness review

Do not use it for a narrow isolated feature implementation unless explicitly requested.

---

# Non-Negotiable Behavior

Do not only inspect the code and produce recommendations.

When a problem is sufficiently understood and can be safely corrected:

1. reproduce or characterize it
2. add a regression test when practical
3. fix the root cause
4. run the relevant tests
5. verify surrounding behavior
6. continue auditing the repository

Do not leave fixable problems as TODO comments.

---

# Repository Reconnaissance

Before making broad changes, inspect the repository sufficiently to understand its architecture.

Identify:

- languages
- frameworks
- package managers
- build systems
- application entry points
- module/package boundaries
- domain logic
- state ownership
- external interfaces
- persistence
- communication protocols
- async/concurrency model
- UI/backend boundaries
- hardware/system boundaries
- configuration
- environment handling
- logging
- error handling
- shutdown lifecycle
- existing test infrastructure
- CI configuration
- lint/typecheck/build commands

Inspect the actual implementation.

Do not infer architecture only from filenames.

---

# Existing Tests Must Be Audited Too

Passing tests are not automatically trustworthy.

Inspect existing tests for:

- assertions that do not verify useful behavior
- tests that test mocks instead of production code
- excessive mocking
- stale assumptions
- accidental always-pass behavior
- missing awaits
- timing dependence
- arbitrary sleeps
- shared mutable state
- execution-order dependence
- leaked resources
- hidden external dependencies
- flaky behavior
- assertions tied to implementation details
- tests that encode an existing bug as desired behavior

Correct weak tests when necessary.

Never weaken a meaningful assertion merely to make the suite green.

---

# Production Code Audit

Systematically inspect production code.

## Correctness

Look for:

- incorrect conditions
- broken branching
- invalid assumptions
- off-by-one errors
- invalid state transitions
- missing validation
- inconsistent state
- stale state
- bad defaults
- invalid conversions
- malformed parsing
- incorrect serialization
- nullable-value bugs
- unhandled edge cases
- swallowed exceptions
- misleading success responses
- partial failure handling

## State and Lifecycle

Look for:

- initialization-order problems
- repeated initialization
- incomplete cleanup
- leaked resources
- listeners/subscriptions not removed
- reconnect bugs
- stale sessions
- stale device references
- duplicate handlers
- inconsistent state after failure
- operations continuing after shutdown

## Async and Concurrency

Investigate:

- missing await/join
- fire-and-forget operations
- races
- cancellation
- timeout semantics
- concurrent mutations
- event ordering
- duplicate events
- locking
- deadlock possibilities
- callbacks after disposal
- stale asynchronous results overwriting newer state

Prefer deterministic synchronization in tests.

Avoid arbitrary sleeps.

## Boundary Handling

Inspect interactions with:

- network
- BLE
- sockets
- IPC
- filesystem
- operating system
- database
- subprocesses
- hardware
- external services

Consider:

- disconnect
- reconnect
- timeout
- malformed data
- partial data
- duplicated data
- out-of-order events
- unavailable dependency
- unexpected response
- retry exhaustion
- cancellation

---

# Security Review

Perform security analysis appropriate to the technology stack.

Look for issues such as:

- command injection
- shell injection
- path traversal
- unsafe filesystem access
- insecure IPC
- unsafe URL handling
- unsafe deserialization
- missing validation at trust boundaries
- prototype pollution where applicable
- secrets in source or logs
- excessive permissions
- overly permissive network exposure
- insecure defaults
- sensitive error disclosure
- dependency misuse
- insufficient privilege separation

For Electron applications also inspect, where relevant:

- contextIsolation
- nodeIntegration
- sandboxing
- preload exposure
- IPC validation
- remote content
- navigation
- new-window behavior
- shell.openExternal usage
- CSP
- renderer trust boundaries

Only make security changes supported by a real threat or unsafe pattern.

Do not introduce disruptive speculative hardening without justification.

---

# Architecture Review

Look for design problems that materially harm:

- correctness
- testability
- reliability
- security
- maintainability
- ownership of state

Examples:

- domain logic in UI code
- global mutable state
- unclear lifecycle ownership
- duplicated business rules
- hidden dependencies
- circular dependencies
- huge multipurpose modules
- infrastructure tightly coupled to business logic
- hardware/network calls embedded directly in core logic
- abstractions that prevent deterministic testing

Refactor when necessary to make meaningful behavior testable.

Do not perform aesthetic rewrites.

Do not replace architecture or frameworks merely because another design is preferred.

---

# Testing Strategy

Build a layered test suite.

Use the cheapest test level capable of giving meaningful confidence.

---

## Unit Tests

Use unit tests for isolated logic.

Cover:

- business rules
- parsing
- validation
- transformations
- state machines
- calculations
- protocol logic
- error handling
- boundary cases

Prefer behavior-oriented tests.

Use:

Given
When
Then

or:

Arrange
Act
Assert

Do not replicate implementation line-by-line.

---

## Functional Tests

Test complete application behaviors spanning multiple internal components.

Examples:

- connection workflow
- discovery workflow
- user action → resulting application state
- reconnect behavior
- settings workflow
- recovery after failure
- startup/shutdown
- persistence workflow
- device control workflow

Test observable outcomes.

---

## Integration Tests

Test real boundaries between application layers.

Examples:

- UI ↔ backend
- renderer ↔ main process
- IPC
- service ↔ repository
- controller ↔ service
- protocol ↔ transport
- persistence
- configuration loading
- serialization
- filesystem integration

Prefer real collaborating components whenever practical.

Mock only the external boundary that needs to be isolated.

Example:

domain logic
→ protocol
→ fake transport

is generally better than mocking every intermediate method.

---

# External Hardware / Service Simulation

Standard CI tests should not depend on real physical hardware.

When hardware or external systems are involved, create deterministic fakes or simulators where practical.

A simulator should be able to represent:

- normal connection
- normal responses
- latency
- disconnect
- reconnect
- missing messages
- malformed messages
- duplicate messages
- out-of-order messages
- unexpected messages
- hardware errors
- partial failure

Real-hardware tests should be explicitly separated, for example:

- hardware-integration
- manual-hardware
- e2e-hardware

They must not destabilize the normal automated suite.

---

# Regression Testing Rule

Every meaningful discovered bug should result in regression protection whenever practical.

Preferred workflow:

1. identify bug
2. understand root cause
3. add failing regression test
4. fix production code
5. verify test passes
6. run adjacent tests
7. search for similar instances

If architecture makes the bug impossible to test directly, consider a minimal refactor that improves testability.

---

# Failure-Path Testing

Explicitly test important failures.

Examples:

- malformed input
- empty input
- timeout
- cancellation
- dependency unavailable
- disconnect during operation
- retry exhaustion
- invalid configuration
- duplicate command
- duplicate event
- stale event
- startup failure
- shutdown during active work
- corrupted persistence
- unknown protocol message
- invalid state transition

Happy-path-only testing is insufficient.

---

# Invariants

Identify critical system invariants and protect them with tests.

Examples:

- mutually exclusive states cannot coexist
- duplicate messages do not duplicate side effects
- failed initialization cannot result in READY state
- cleanup releases all owned resources
- shutdown prevents new commands
- stale asynchronous responses cannot overwrite current state
- invalid protocol input cannot corrupt application state
- UI-visible state reflects backend state

Use invariants especially around state machines and concurrent logic.

---

# Property-Based and Parameterized Testing

Use parameterized or property-based testing when it adds meaningful confidence.

Good targets:

- parsers
- serializers
- protocol frames
- coordinate calculations
- numerical transformations
- normalization
- state transitions
- validation
- ranges
- reversible transformations

Do not use property-based testing where straightforward examples are clearer.

---

# Test Doubles

Choose test doubles deliberately.

Prefer:

- fake for meaningful behavior
- stub for controlled output
- spy only where interaction itself is contractually important
- mock sparingly

Avoid deep mock chains.

Do not mock the code under test.

Do not create abstractions only for the sake of mocking unless they also clarify an actual boundary.

---

# Determinism

Tests must be deterministic.

Avoid:

- arbitrary sleep()
- reliance on real clock time
- race-prone timing assumptions
- test-order dependence
- uncontrolled randomness
- live network requests
- live hardware unless explicitly separated

Where needed, inject or control:

- clock
- scheduler
- random generator
- transport
- filesystem
- network
- event source

---

# Coverage

Run coverage tooling when available.

Inspect:

- statement coverage
- branch coverage
- function coverage
- uncovered critical modules

Pay special attention to uncovered:

- branches
- failures
- state transitions
- protocol handling
- concurrency
- lifecycle
- boundary validation

Do not generate meaningless tests solely to increase the percentage.

Coverage gaps in critical code require investigation.

Coverage gaps in trivial boilerplate may be acceptable.

---

# Bug-Fixing Authority

You are authorized to modify production code for:

- confirmed bugs
- unsafe behavior
- incorrect error handling
- resource leaks
- races
- invalid state handling
- security vulnerabilities
- broken lifecycle management
- architectural issues that materially prevent testing or reliability

Preserve existing externally observable behavior unless it is clearly incorrect or unsafe.

If intent cannot be determined with certainty, choose the smallest and safest reasonable change and document the assumption.

---

# Forbidden Shortcuts

Never make the project appear healthy by:

- deleting failing tests
- disabling tests
- marking legitimate tests skipped
- weakening assertions
- catching and ignoring unexpected exceptions
- increasing timeouts arbitrarily
- adding sleeps until tests pass
- excluding important production code from coverage
- disabling type checking
- disabling lint rules
- suppressing meaningful warnings
- mocking the behavior being tested
- modifying production code purely to satisfy an incorrect test

Fix root causes.

---

# Compatibility

Preserve unless a real defect requires changing them:

- public APIs
- persisted data formats
- configuration formats
- IPC contracts
- network protocols
- device protocols
- user-visible behavior

If a compatibility break is necessary for correctness or security:

- minimize it
- update all known callers
- add tests
- document it clearly

---

# Working Loop

Audit the repository iteratively.

For each subsystem:

1. inspect implementation
2. understand responsibilities
3. inspect tests
4. identify high-risk behavior
5. identify missing coverage
6. add or improve tests
7. run focused tests
8. investigate failures
9. fix root causes
10. add regression protection
11. rerun focused tests
12. continue

Periodically run the complete suite.

Do not postpone whole-repository verification until the very end.

---

# Prioritization

Prioritize work approximately in this order:

1. crashes / data corruption
2. security vulnerabilities
3. concurrency / lifecycle defects
4. incorrect user-visible behavior
5. state consistency problems
6. integration failures
7. error recovery
8. missing critical tests
9. architectural testability problems
10. lower-risk coverage gaps

Avoid spending disproportionate time on trivial code while critical stateful logic remains weakly tested.

---

# Verification

Before declaring completion, run every relevant repository check.

Examples:

- unit tests
- functional tests
- integration tests
- regression tests
- type checking
- linting
- formatter verification
- build
- packaging
- coverage

Also inspect output for:

- warnings
- leaked handles
- unhandled promise/task failures
- async cleanup failures
- console errors
- resource leaks
- flaky behavior

An exit code of zero does not automatically mean the application is healthy.

---

# Completion Criteria

The work is complete only when, to the extent possible in the environment:

- the repository has been broadly inspected
- important behavior has meaningful test coverage
- discovered bugs have been fixed
- regressions have tests
- critical error paths are tested
- tests are deterministic
- integration boundaries are exercised
- production code is testable
- build passes
- type checking passes
- linting passes
- automated tests pass
- important remaining risks are documented

Do not stop after auditing only the first convenient modules.

---

# Final Report

At completion, provide a concise report.

## Summary

State the overall health of the repository after the work.

## Tests added or improved

Include:

- unit tests
- functional tests
- integration tests
- regression tests
- simulators/fakes
- important scenarios covered

## Bugs fixed

For each meaningful bug describe:

- issue
- root cause
- fix
- regression coverage

## Security findings

Describe:

- vulnerability or unsafe pattern
- severity
- fix

Do not inflate severity.

## Architecture changes

Mention only substantive changes.

Explain why each change was needed.

## Verification

Report actual results for:

- tests
- build
- typecheck
- lint
- coverage

Do not claim checks were executed if they were not.

## Remaining risks

List anything that could not be fully validated, especially:

- real hardware behavior
- OS-specific behavior
- external services
- unavailable credentials
- unavailable infrastructure

Explain what would be required to validate each remaining risk.

---

# Final Engineering Rules

Test behavior, not implementation.

Fix root causes, not symptoms.

Prefer realistic fakes over deep mocking.

Every bug deserves regression protection.

Treat async and lifecycle code as high risk.

Treat external input as untrusted.

Do not confuse coverage with quality.

Do not rewrite working code without engineering justification.

Do not report a fix when you can safely implement it.

Do not claim verification that was not actually performed.

Continue until the repository as a whole—not merely one subsystem—has been meaningfully audited.
