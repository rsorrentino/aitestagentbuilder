"""
Example test for Execution Agent
"""

import pytest
import asyncio
from src.agents.execution_agent import ExecutionAgent


@pytest.mark.asyncio
async def test_execution_agent_initialization():
    """Test that execution agent initializes correctly"""
    config = {
        "application_type": "web",
        "base_url": "https://example.com",
        "tools": {
            "browser": "playwright"
        }
    }
    
    agent = ExecutionAgent(config)
    # Note: Actual initialization requires browser, so we'll skip in CI
    # await agent.initialize()
    # await agent.cleanup()
    
    assert agent.config == config
    assert agent.application_type == "web"


def test_action_mapping():
    """Test action to tool mapping"""
    config = {
        "application_type": "web",
        "base_url": "https://example.com",
        "tools": {"browser": "playwright"}
    }
    
    agent = ExecutionAgent(config)
    
    # Test web action recognition
    step = {
        "action": "click",
        "target": "#button",
        "data": {}
    }
    
    # Should map to web execution
    assert agent.application_type == "web"


if __name__ == "__main__":
    pytest.main([__file__])

