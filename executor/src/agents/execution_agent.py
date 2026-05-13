"""
Execution Agent
Executes test steps using appropriate tools
"""

import asyncio
from typing import Dict, Any, List, Optional
from ..tools.browser.playwright_tool import get_playwright_tool
from ..tools.api.http_tool import get_http_tool
from ..tools.mobile.appium_tool import get_appium_tool
import os


class ExecutionAgent:
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.application_type = config.get("application_type", "web")
        self.base_url = config.get("base_url", "")
        self.tools = config.get("tools", {})
        self.playwright_tool = None
        self.http_tool = None
        self.appium_tool = None

    async def initialize(self):
        """Initialize tools based on configuration"""
        if self.application_type == "web" and self.tools.get("browser") == "playwright":
            headless = os.getenv("PLAYWRIGHT_HEADLESS", "true").lower() == "true"
            browser = os.getenv("PLAYWRIGHT_BROWSER", "chromium")
            self.playwright_tool = get_playwright_tool(headless=headless, browser=browser)
            await self.playwright_tool.initialize()

        if self.tools.get("http") == "axios" or self.application_type == "api":
            self.http_tool = get_http_tool(base_url=self.base_url)

        if self.application_type == "mobile" and self.tools.get("mobile") == "appium":
            server_url = self.config.get("appium_server_url", "http://localhost:4723")
            self.appium_tool = get_appium_tool(server_url=server_url)
            # Initialize with platform-specific config
            platform = self.config.get("platform", "android")
            self.appium_tool.initialize(platform=platform, **self.config.get("appium_capabilities", {}))

    async def execute_step(self, step: Dict[str, Any], context: Dict[str, Any] = None) -> Dict[str, Any]:
        """Execute a single test step"""
        if context is None:
            context = {}

        action = step.get("action", "").lower()
        target = step.get("target", "")
        data = step.get("data", {})

        # Map action to tool method
        if self.application_type == "web" and self.playwright_tool:
            return await self._execute_web_action(action, target, data, context)
        elif self.application_type == "api" and self.http_tool:
            return await self._execute_api_action(action, target, data, context)
        elif self.application_type == "mobile" and self.appium_tool:
            return await self._execute_mobile_action(action, target, data, context)
        else:
            return {"success": False, "error": f"No suitable tool for application type: {self.application_type}"}

    async def _execute_web_action(self, action: str, target: str, data: Dict, context: Dict) -> Dict[str, Any]:
        """Execute web action using Playwright"""
        if action.startswith("navigate") or action.startswith("go to"):
            url = target if target.startswith("http") else f"{self.base_url}{target}"
            return await self.playwright_tool.navigate(url)

        elif action.startswith("click"):
            return await self.playwright_tool.click(target)

        elif action.startswith("fill") or action.startswith("enter") or action.startswith("type"):
            value = data.get("value") or data.get("text") or str(data)
            return await self.playwright_tool.fill(target, value)

        elif action.startswith("select"):
            value = data.get("value") or data.get("option")
            return await self.playwright_tool.select_option(target, value)

        elif action.startswith("get text") or action.startswith("read"):
            return await self.playwright_tool.get_text(target)

        elif action.startswith("wait"):
            return await self.playwright_tool.wait_for_selector(target)

        elif action.startswith("screenshot"):
            path = data.get("path")
            return await self.playwright_tool.screenshot(path)

        else:
            return {"success": False, "error": f"Unknown web action: {action}"}

    async def _execute_api_action(self, action: str, target: str, data: Dict, context: Dict) -> Dict[str, Any]:
        """Execute API action using HTTP tool"""
        endpoint = target
        headers = data.get("headers", {})
        body = data.get("body") or data.get("data")

        if action.startswith("get"):
            params = data.get("params", {})
            return self.http_tool.get(endpoint, params=params, headers=headers)

        elif action.startswith("post"):
            json_data = body if isinstance(body, dict) else None
            return self.http_tool.post(endpoint, json_data=json_data, headers=headers)

        elif action.startswith("put"):
            json_data = body if isinstance(body, dict) else None
            return self.http_tool.put(endpoint, json_data=json_data, headers=headers)

        elif action.startswith("delete"):
            return self.http_tool.delete(endpoint, headers=headers)

        else:
            return {"success": False, "error": f"Unknown API action: {action}"}

    async def _execute_mobile_action(self, action: str, target: str, data: Dict, context: Dict) -> Dict[str, Any]:
        """Execute mobile action using Appium"""
        by = data.get("by", "id")

        if action.startswith("click") or action.startswith("tap"):
            return self.appium_tool.click(target, by=by)

        elif action.startswith("fill") or action.startswith("enter") or action.startswith("type"):
            text = data.get("value") or data.get("text") or str(data)
            return self.appium_tool.send_keys(target, text, by=by)

        elif action.startswith("get text") or action.startswith("read"):
            return self.appium_tool.get_text(target, by=by)

        elif action.startswith("swipe"):
            coords = data.get("coordinates", {})
            return self.appium_tool.swipe(
                coords.get("start_x", 0),
                coords.get("start_y", 0),
                coords.get("end_x", 100),
                coords.get("end_y", 100),
                coords.get("duration", 1000)
            )

        elif action.startswith("screenshot"):
            path = data.get("path")
            return self.appium_tool.screenshot(path)

        else:
            return {"success": False, "error": f"Unknown mobile action: {action}"}

    async def cleanup(self):
        """Cleanup resources"""
        if self.playwright_tool:
            await self.playwright_tool.close()
        if self.appium_tool:
            self.appium_tool.close()

