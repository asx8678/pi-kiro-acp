# Examples

`kiro-acp.overrides.json` is a partial validated user configuration. Prefer creating
your actual complete file with `init --experimental`. Its null planner ID means
select an actual live model; it is not a placeholder sent to Kiro.

`fabric.merge.json` is a merge fragment for an existing Fabric configuration.
It does not select Main's model. Confirm `kiro-acp/auto` is visible first and keep
`runner: pi` with extensions enabled. Do not overwrite unrelated Fabric settings.

`PLANNER.md` is an optional instruction template, not an automatically installed
prompt or a model-selection override. Integrate it with the Pi skills/instructions
you actually use after review.
