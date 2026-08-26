# 5. Visual regression runs against the real stack and its own database

Date: 2026-08-04

Status: Accepted

## Context

The design standard makes visual regression one of the eight passes every phase
has to clear. That only means something if the screenshots depict the product a
user would get, and if a difference between two runs is caused by a change to the
product rather than by the test setup.

Two ways of building this suite were considered and rejected.

Mocking the API and photographing components in isolation is the cheap option and
was rejected because it inverts the purpose of the gate. A mocked screen renders
identically whether or not the request behind it works. The first version of this
suite that drove the real API immediately found that no object could be stored at
all: the API asks for server-side encryption on every write, and the development
MinIO had no key service configured, so it refused every `PutObject`. Every
backend unit test passed throughout, because they used a substitute object store.
A mocked visual suite would have passed too, and the phase would have closed with
intake unable to store anything.

Pointing the suite at the shared development database was the obvious next option
and was also rejected. Intake records are immutable by design, so they accumulate.
A screenshot of the intake queue therefore drifts from run to run, and a test that
photographs an empty queue passes or fails depending on whether some other test
happened to add a row first. Both produce a failure indistinguishable from a real
layout regression, and the natural response to a baseline that fails for no reason
is to overwrite it, which is how a suite stops being a gate.

## Decision

The suite drives the real API, the real database, the real object store and the
real malware scanner. Nothing on the path under test is substituted.

It gets its own database, `finora_visual`, dropped and rebuilt by migration before
the API starts. The reset is chained into the command that launches the API rather
than run as a separate setup step, so the API cannot come up against a database
that was not rebuilt. The reset script refuses to run unless the resolved database
is that exact name and the environment is development.

Records are created by driving the product, not by seeding rows. The one document
the suite uploads is a fixed byte sequence, so with a rebuilt database it produces
a constant filename and a constant content hash and the screens that show it can
have baselines.

Specs that create records run in their own project, declared to depend on the
viewport projects, so they cannot add a row while another project is photographing
a screen's starting state.

Values that are genuinely unrepeatable, timestamps in particular, are marked
`data-visual-volatile` and hidden for the screenshot while keeping their space in
the layout, so their position is still verified and their content cannot make a
baseline fail.

In CI a missing baseline fails the job instead of being written. Baselines are
platform-specific, and a job that generates its own would be comparing a picture
to itself and reporting success against something nobody approved.

## Consequences

- The suite needs the Compose stack, or the equivalent service containers in CI,
  including ClamAV, which is slow to become ready because it loads its signature
  database first. That wait is accepted: an upload that cannot be scanned is
  quarantined, so a suite that tolerated a missing scanner would be asserting the
  failure mode instead of the behaviour.
- Baselines are committed per platform and per viewport. A contributor on a
  different operating system regenerates the ones for theirs; they do not replace
  the existing ones.
- The suite is not hermetic with respect to object storage. Keys are derived from
  content, and an immutable put returns the existing object when the hash matches,
  so a repeated run is idempotent rather than an error, and the buckets are not
  reset between runs.
- Screenshots of populated screens are limited to what the suite itself creates.
  Photographing a wider variety of states means teaching it to create those
  states through the product, which is more work than seeding rows and is the
  reason the release bar's prohibition on fabricated sample data holds here too.
