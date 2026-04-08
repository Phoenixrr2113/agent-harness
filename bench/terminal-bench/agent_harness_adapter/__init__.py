"""Harbor agent adapter for agent-harness.

Register with Harbor via:
    harbor run -d terminal-bench/terminal-bench-2 \
        --agent-import-path agent_harness_adapter:AgentHarness \
        -m qwen/qwen3-coder
"""

from agent_harness_adapter.agent import AgentHarness

__all__ = ["AgentHarness"]
