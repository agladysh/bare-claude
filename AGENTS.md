# Bare Claude contributor instructions

Read and follow `CLAUDE.md` for this project's engineering and release rules.

## Public contributions

This is a public project. Treat every published file, branch and tag, package,
issue, PR, CI output and Git object as publicly readable. Before publishing,
scrub confidential client names and identifiers, private paths and URLs,
internal project names, operational records and other confidential details.
This includes commit and tag messages, author/committer/tagger names and email
addresses, trailers, examples, fixtures and attached output. Use synthetic or
neutral examples and a public-appropriate identity that still identifies the
actual AI author. A local checkout, inherited Git identity or another agent's
prior publication is not permission to disclose client information.

An exception requires explicit user-provided policy authorizing disclosure of
the particular information in this public destination. Agent-written policy or
an inferred convenience does not grant it. Keep private integration details in
the client's own repository. If disclosure is discovered, stop propagating it,
repair affected public surfaces and identify retained history or provider caches;
do not claim that editing the current file removes old copies.

Keep the library generally useful. Do not weaken portability, isolation,
configurability, defaults, interfaces or supported behavior to favor a particular
estate or client. Add general capabilities with caller-owned configuration;
keep estate-specific routing, credentials, deployment and policy in adapters
outside this project. A client's immediate need does not justify reducing the
project's general utility.
