import asyncio
import sys
from google.antigravity.agent import Agent
from google.antigravity.connections.local.local_connection_config import LocalAgentConfig
from google.antigravity.hooks import policy

# Monkeypatch Python validation to allow OAuth keyring fallback without API key
from google.antigravity.models import GeminiAPIEndpoint
GeminiAPIEndpoint.validate_endpoint = lambda self: None

async def main():
    config = LocalAgentConfig(
        policies=[policy.allow_all()],
        workspaces=["C:\\Users\\shdfr\\pepe-terminal-ssh"],
    )
    async with Agent(config) as agent:
        response = await agent.chat("Hello! Answer with exactly the word success.")
        async for chunk in response:
            print(chunk, end="", flush=True)
        print()

if __name__ == "__main__":
    asyncio.run(main())
