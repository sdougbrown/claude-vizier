---
name: vizier
description: The Vizier appraises the agent's last turn with a second model. Usage — /vizier [on|off|model [spec]|key [token|clear]|<spec>]
disable-model-invocation: true
argument-hint: "[on|off|model [spec]|key [token|clear]|spec]"
---

The Vizier is normally intercepted by this plugin's UserPromptSubmit hook before
the prompt reaches you, so you should never see this text. If you are reading
it, the hook did not run.

Tell the user, in one short line: the Vizier's hook is not active — check that
the plugin's hooks loaded (`/hooks`) and that `jq` is installed. Do not
appraise your own work; that is the whole point of the Vizier.

Arguments given: $ARGUMENTS
