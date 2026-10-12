# ADR 0008: The glossary is architectural memory

## Context

The architect guards ownership, dependency direction, contracts and system
shape against `ARCHITECTURE.md` and the records in `docs/adr/`. Language was
not guarded: a `Client` beside `Customer`, a `bill` beside `Invoice`, slip in
one edit at a time and become precedent the same way a crossed boundary does.
Matt Pocock's domain-modeling skill keeps a project's language in
`GLOSSARY.md` (a term, its definition, the words to avoid; one per context when
there are several, listed in `GLOSSARY-MAP.md`) and writes ADRs in the same
`docs/adr/` with the same three criteria the architect's Record mode already
uses. The skill does the conversation; nothing watched the code afterwards.

## Decision

A glossary in that format is read as a third memory beside `ARCHITECTURE.md`
and the decision records, in the same Jev request and at the same four moments
of ADR 0007. Each term is held against the change on its own, as each decision
record is: does the change name the concept by the glossary's term, misname it,
or not touch it. One further question asks whether the change names a domain
concept the glossary lacks or gives a covered one a second name. A misnamed
term wakes the note with the term quoted to its line in the glossary; the line
is known from parsing, no find is needed. A new term returns at the end of the
turn like an unrecorded decision. The architect may write the glossaries in
Record and nowhere else; sessionkit never creates a glossary, and edits of one
are not checked. The skill's interactive part, challenging terms in
conversation, stays in the skill.

## Consequences

- A repository without a glossary sees no change: no term questions, no new
  term question.
- Per change the request grows by one Choice per term and one Noul; terms are
  short and come off the top of the reference's share of the state.
- The format is the skill's; sessionkit reads `**Term**:` and `_Avoid_:` and
  nothing else. A glossary in another shape is read as having no terms.
- Naming inside one module stays the coding agent's; only names of concepts
  the glossary defines are judged.
