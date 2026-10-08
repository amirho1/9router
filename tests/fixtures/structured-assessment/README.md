# Synthetic structured assessment fixture

`structured-assessment.json` represents a streaming Chat Completions request
produced by LangChain with `structuredOutputMethod: "jsonSchema"`. Client names
and prompt identifiers were anonymized; the JSON Schema structure and constraints
were retained. The fixture includes local `$defs` and `$ref` pointers, numeric
literal alternatives, nullable fields, required properties, and system guidance.
Its document, context, and assessment data are synthetic. It contains no
credentials or request headers.

The tests verify that translation and executor cleanup preserve the schema and
instructions. A separate client adapter check reconstructed a valid assessment
from fragmented SSE. A live synthetic assessment passed validation on its first
attempt with repair disabled. These checks do not add a runtime dependency to
9Router.

Run the deterministic gateway tests from `tests/`:

```sh
npx vitest run unit/gemini-schema-compiler.test.js unit/schema-error-routing.test.js unit/structured-output-and-tools.test.js unit/gemini-unknown-schema-fields.test.js
```
