"""
Execution Agent
Executes test steps using appropriate tools
"""

import asyncio
from typing import Dict, Any, List, Optional
from ..tools.browser.playwright_tool import get_playwright_tool
from ..tools.api.http_tool import get_http_tool
from ..tools.mobile.appium_tool import get_appium_tool
from .self_healing_agent import SelfHealingAgent
import os


class ExecutionAgent:
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.application_type = config.get("application_type", "web")
        self.base_url = config.get("base_url", "")
        self.tools = config.get("tools", {})
        self.platform = config.get("platform", "")
        self.playwright_tool = None
        self.http_tool = None
        self.appium_tool = None

        # AI self-healing configuration
        ai_config = config.get("ai", {})
        self.self_healing_enabled = ai_config.get("self_healing", False)
        ai_provider = ai_config.get("provider", "openai")
        ai_model = ai_config.get("model")
        self._self_healer: Optional[SelfHealingAgent] = (
            SelfHealingAgent(provider=ai_provider, model=ai_model)
            if self.self_healing_enabled else None
        )

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
        """Execute web action using Playwright, with optional self-healing on failure."""
        result = await self._execute_web_action_once(action, target, data, context)

        # Attempt self-healing if enabled and the step failed with a selector issue
        if (
            not result.get("success")
            and self.self_healing_enabled
            and self._self_healer
            and self.playwright_tool
            and self.playwright_tool.page
        ):
            error_msg = result.get("error", "")
            if "Timeout" in error_msg or "selector" in error_msg.lower() or "locator" in error_msg.lower():
                heal_result = await self._self_healer.suggest_selector(
                    self.playwright_tool.page,
                    failed_selector=target,
                    action=action,
                    context_description=str(context),
                )
                if heal_result.get("success") and heal_result.get("selector"):
                    new_selector = heal_result["selector"]
                    result = await self._execute_web_action_once(action, new_selector, data, context)
                    if result.get("success"):
                        result["healed"] = True
                        result["original_selector"] = target
                        result["healed_selector"] = new_selector

        return result

    async def _execute_web_action_once(self, action: str, target: str, data: Dict, context: Dict) -> Dict[str, Any]:
        """Single attempt at executing a web action using Playwright."""
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

        # --- Salesforce-specific actions ---
        elif action == "salesforce_login":
            sf = self.config.get("salesforce", {})
            username = data.get("username") or sf.get("username", "")
            password = data.get("password") or sf.get("password", "")
            url = target or self.base_url
            return await self.playwright_tool.salesforce_login(url, username, password)

        elif action == "wait_for_lightning":
            return await self.playwright_tool.wait_for_lightning()

        elif action == "get_lightning_component":
            return await self.playwright_tool.get_lightning_component(target)

        elif action == "handle_classic_popup":
            popup_action = data.get("action", "accept")
            return await self.playwright_tool.handle_classic_popup(action=popup_action)

        elif action == "salesforce_navigate_to_app":
            app_name = target or data.get("app_name", "")
            return await self.playwright_tool.salesforce_navigate_to_app(app_name)

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

