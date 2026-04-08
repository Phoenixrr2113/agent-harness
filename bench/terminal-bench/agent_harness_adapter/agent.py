"""agent-harness adapter for the Harbor benchmark framework.

Mirrors the pattern used by harbor.agents.installed.qwen_code.QwenCode:
- Installs Node 20 via nvm inside the task container
- Installs agent-harness from an npm-compatible source (git url, tarball, or package name)
- Invokes `harness run <instruction> -p openrouter -m <model>` as a one-shot per task
- Captures stdout/stderr into /logs/agent/agent-harness.txt for inspection

Required env vars on the host (forwarded into the container via ENV_VARS):
    OPENROUTER_API_KEY   — credential for the LLM provider
    HARNESS_INSTALL_SOURCE (optional) — npm install spec; defaults to the GitHub repo

Harbor invocation:
    harbor run \\
        -d terminal-bench/terminal-bench-2 \\
        --agent-import-path agent_harness_adapter:AgentHarness \\
        -m qwen/qwen3-coder \\
        -l 5 -n 2
"""

import os
import shlex

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    EnvVar,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


# Default install source. Override with HARNESS_INSTALL_SOURCE on the host.
# Accepts anything `npm install -g` takes: a git url, a tarball url, an npm
# package name, or a local path mounted into the container.
DEFAULT_INSTALL_SOURCE = "git+https://github.com/randywilson/agent-harness.git"


class AgentHarness(BaseInstalledAgent):
    """agent-harness: a file-first general-purpose agent runtime."""

    # Out-of-tree agents don't need to be in the AgentName enum — Harbor loads
    # this class via --agent-import-path. `name()` is still used for logging.
    @staticmethod
    def name() -> str:
        return "agent-harness"

    # Credentials and install source are forwarded from the host into the
    # container environment. Harbor's base class resolves these from host env
    # vars (via env_fallback) and exposes them as self._resolved_env_vars.
    ENV_VARS = [
        EnvVar(
            kwarg="openrouter_api_key",
            env="OPENROUTER_API_KEY",
            type="str",
            env_fallback="OPENROUTER_API_KEY",
        ),
        EnvVar(
            kwarg="install_source",
            env="HARNESS_INSTALL_SOURCE",
            type="str",
            env_fallback="HARNESS_INSTALL_SOURCE",
            default=DEFAULT_INSTALL_SOURCE,
        ),
    ]

    # ------------------------------------------------------------------ #
    # Version detection — best-effort, runs after install().
    # ------------------------------------------------------------------ #

    def get_version_command(self) -> str | None:
        return ". ~/.nvm/nvm.sh; harness --version"

    # ------------------------------------------------------------------ #
    # Install phase — runs once per task container before run().
    # Installs Node 20 via nvm and then `npm install -g <install_source>`.
    # ------------------------------------------------------------------ #

    async def install(self, environment: BaseEnvironment) -> None:
        # System packages required for nvm bootstrap + git (for git+ install sources).
        await self.exec_as_root(
            environment,
            command="apt-get update && apt-get install -y curl git ca-certificates",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

        install_source = self._resolved_env_vars.get(
            "HARNESS_INSTALL_SOURCE", DEFAULT_INSTALL_SOURCE
        )
        escaped_source = shlex.quote(install_source)

        # Install nvm → Node 20 → agent-harness. Matches the shape of
        # QwenCode.install() so the same CI assumptions hold.
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "curl -fsSL -o- "
                "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh "
                "| bash && "
                'export NVM_DIR="$HOME/.nvm" && '
                '\\. "$NVM_DIR/nvm.sh" || true && '
                "command -v nvm &>/dev/null || { "
                "echo 'Error: NVM failed to load' >&2; exit 1; } && "
                "nvm install 20 && "
                "nvm alias default 20 && "
                "node --version && npm --version && "
                f"npm install -g {escaped_source} && "
                "harness --version"
            ),
        )

    # ------------------------------------------------------------------ #
    # Run phase — called once per task with the rendered instruction.
    # ------------------------------------------------------------------ #

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        escaped_instruction = shlex.quote(instruction)

        # Forward OPENROUTER_API_KEY into the agent process.
        env = {**self._resolved_env_vars}
        env.pop("HARNESS_INSTALL_SOURCE", None)  # not needed at run time

        # Model name comes from Harbor's -m flag and is exposed as
        # self.model_name. For OpenRouter we pass the vendor-prefixed id
        # through unchanged (e.g. "qwen/qwen3-coder", "anthropic/claude-sonnet-4").
        model = self.model_name or os.environ.get("HARNESS_MODEL", "qwen/qwen3-coder")

        # Ensure the logs/agent dir exists so the tee target is writable.
        await self.exec_as_agent(
            environment,
            command="mkdir -p /logs/agent",
        )

        await self.exec_as_agent(
            environment,
            command=(
                ". ~/.nvm/nvm.sh; "
                f"harness run {escaped_instruction} "
                f"--provider openrouter "
                f"--model {shlex.quote(model)} "
                f"2>&1 | stdbuf -oL tee /logs/agent/agent-harness.txt"
            ),
            env=env,
        )

    # ------------------------------------------------------------------ #
    # Trajectory parsing — intentionally a no-op for v0. Token counts and
    # trajectory visualization on the Harbor dashboard will be missing.
    # Revisit when `harness run` gains a structured-trace output flag.
    # ------------------------------------------------------------------ #

    def populate_context_post_run(self, context: AgentContext) -> None:
        return None
