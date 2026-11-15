# MARI BASE AEO membership verifier

MARI BASE contains a server-side Node.js Ed25519 verifier for AEO membership credentials and UCCS `uccs/1` registration envelopes.

## Role and isolation

MARI BASE is an independent backend platform, not the AEO ecosystem's mandatory gateway or sole authority. This module performs local verification only. It does not create a registry endpoint, route peer traffic, change the MARI database, add migrations, or make MARI BASE a mandatory dependency.

Membership proves platform ecosystem registration only. It does not authenticate a live device/session, authorize capability invocation, or represent user consent. Provider-owned capability grants, peer authentication, scope checks, expiry, replay protection, and consent remain separate.

## Trust inputs

The caller must supply the trusted issuer public-key set and a revocation checker. Verification fails closed if the revocation checker errors or reports revoked/unknown status. The verifier accepts raw 32-byte Ed25519 public keys and uses Node's native Ed25519 signature verification.

No private key, production issuer, trust root, credential, or revocation service is provisioned here. Root-signed trust-bundle verification, persistent anti-rollback state, and root rotation/recovery are still outstanding.

## Validation

Node tests cover valid credentials, signature tampering, unknown keys, revocation, wrong audience, expiry, and registration identity binding. CI results must pass before this module is considered build-verified.


## Root-signed trust bundles

The service verifies trust bundles signed by a pinned AEO Ed25519 root, validates issuer-key records and the credential revocation list, and enforces expiry and a caller-supplied minimum version. Persist the highest accepted version outside this pure verifier and pass it as `minimumVersion` to prevent rollback. No production root, private key, issuer credential, or revocation service is provisioned here. Root rotation/recovery and live distribution remain production prerequisites.
