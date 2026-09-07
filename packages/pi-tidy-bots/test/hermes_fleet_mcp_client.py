"""Disposable installed-MCP interoperability probe; never imports Hermes/provider code."""
import asyncio
from importlib.metadata import version
import json
import sys

import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def main():
    assert version("mcp") == "2.0.0"
    descriptor = json.load(sys.stdin)
    headers = {item["name"]: item["value"] for item in descriptor["headers"]}
    async with httpx2.AsyncClient(headers=headers) as http:
        async with streamable_http_client(descriptor["url"], http_client=http) as streams:
            async with ClientSession(*streams) as session:
                await session.initialize()
                listing = await session.list_tools()
                assert {tool.name for tool in listing.tools} == {"fleet_discover", "fleet_send"}
                identity = {"sessionId": "acp-one", "promptId": "prompt-one", "nativeToolCallId": "python-native-call", "toolName": "fleet_send"}
                for _ in range(2):
                    result = await session.call_tool("fleet_send", arguments={"target": "peer", "text": "fixture"}, meta={"tidy": identity})
                    assert not result.is_error
    print("installed_mcp_interoperability_passed")


asyncio.run(main())
