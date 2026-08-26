# 4. PyJWT for OIDC token validation, not python-jose

Date: 2026-08-04

Status: Accepted

## Context

The API needs to validate OIDC ID tokens signed by the identity provider. The
initial dependency set specified `python-jose[cryptography]`, which is a common
choice in FastAPI examples.

`python-jose` depends unconditionally on `ecdsa`, including when the
`cryptography` extra is installed. `ecdsa` carries an advisory
(PYSEC-2026-1325) with no fix version: its authors state that the library is
not constant-time and that resistance to side-channel attacks is out of scope.
`pip-audit` therefore fails on a clean install, and the finding cannot be
resolved by upgrading.

`python-jose` is also effectively unmaintained, which matters for a component
sitting directly on the authentication path.

## Decision

Use `pyjwt[crypto]` instead. It performs all signature verification through
`cryptography`, which is actively maintained and uses constant-time primitives,
and it does not depend on `ecdsa`.

Signed session cookies and vendor action links do not use either library. Those
are handled by `itsdangerous`, which produces a keyed HMAC rather than a JWT,
because a browser session identifier and a one-time action link do not need to
be a self-describing token and are better off not being parseable by anything
that receives them.

## Consequences

- `pip-audit` passes with no ignored findings, so the dependency gate does not
  need a standing exception that would mask the next real advisory.
- The token-validation call sites differ from most FastAPI tutorials. PyJWT
  requires the audience and issuer to be passed explicitly to `jwt.decode`, and
  omitting them silently disables those checks, so both are always supplied
  from configuration.
- Algorithms are pinned at the call site. PyJWT requires an explicit
  `algorithms` list, which closes the algorithm-confusion class of attack where
  a token presents `alg: none` or a symmetric algorithm against a public key.
