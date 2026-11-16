# MARI BASE AEO membership and trust verifier

MARI BASE contains a server-side Node.js Ed25519 verifier for AEO membership credentials, UCCS `uccs/1` registration envelopes, and root-signed trust bundles.

## Role and isolation

MARI BASE is an independent backend platform, not the AEO ecosystem's mandatory gateway or sole authority. These modules perform local verification only. They do not create a registry endpoint, route peer traffic, change the MARI database, add migrations, or make MARI BASE a mandatory dependency.

Membership proves platform ecosystem registration only. It does not authenticate a live device/session, authorize capability invocation, or represent user consent. Provider-owned capability grants, peer authentication, scope checks, expiry, replay protection, and consent remain separate.

## Trust inputs

The caller supplies trusted issuer keys and a revocation checker. Verification fails closed if revocation status cannot be checked. Root-signed bundles are verified against out-of-band pinned AEO Ed25519 root public keys; issuer keys and revocation IDs are validated, bundle expiry is bounded, and the caller-supplied `minimumVersion` prevents rollback. Persist the highest accepted version outside this pure verifier. No private key, production issuer, trust root, credential, or revocation service is provisioned here.

## Remaining production requirements

Root custody, key rotation/recovery, live issuer/revocation distribution, and initial platform registration remain outstanding. Membership and trust-bundle validity never grant capability access.

## Validation

Node tests cover valid and invalid membership credentials, signature tampering, unknown keys, revocation, wrong audience, expiry, registration identity binding, valid root-signed trust bundles, and rollback rejection. CI results must pass before merge.
