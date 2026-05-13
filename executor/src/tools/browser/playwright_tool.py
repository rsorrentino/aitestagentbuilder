"""
Playwright Browser Tool
Handles web browser automation
"""

from playwright.async_api import async_playwright, Page, Browser, BrowserContext
import asyncio
import os
from typing import Dict, Any, Optional
import base64


class PlaywrightTool:
    def __init__(self, headless: bool = True, browser: str = "chromium"):
        self.headless = headless
        self.browser_type = browser
        self.playwright = None
        self.browser: Optional[Browser] = None
        self.context: Optional[BrowserContext] = None
        self.page: Optional[Page] = None

    async def initialize(self):
        """Initialize Playwright browser"""
        self.playwright = await async_playwright().start()
        
        browser_map = {
            "chromium": self.playwright.chromium,
            "firefox": self.playwright.firefox,
            "webkit": self.playwright.webkit,
        }
        
        browser_launcher = browser_map.get(self.browser_type, self.playwright.chromium)
        self.browser = await browser_launcher.launch(headless=self.headless)
        self.context = await self.browser.new_context(
            viewport={"width": 1920, "height": 1080},
            record_video_dir="./videos" if not self.headless else None,
        )
        self.page = await self.context.new_page()

    async def navigate(self, url: str) -> Dict[str, Any]:
        """Navigate to a URL"""
        try:
            await self.page.goto(url, wait_until="networkidle")
            return {"success": True, "url": self.page.url}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def click(self, selector: str, timeout: int = 30000) -> Dict[str, Any]:
        """Click an element"""
        try:
            await self.page.click(selector, timeout=timeout)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def fill(self, selector: str, value: str, timeout: int = 30000) -> Dict[str, Any]:
        """Fill an input field"""
        try:
            await self.page.fill(selector, value, timeout=timeout)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def select_option(self, selector: str, value: str, timeout: int = 30000) -> Dict[str, Any]:
        """Select an option in a dropdown"""
        try:
            await self.page.select_option(selector, value, timeout=timeout)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def get_text(self, selector: str, timeout: int = 30000) -> Dict[str, Any]:
        """Get text content of an element"""
        try:
            text = await self.page.text_content(selector, timeout=timeout)
            return {"success": True, "text": text}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def wait_for_selector(self, selector: str, timeout: int = 30000) -> Dict[str, Any]:
        """Wait for an element to appear"""
        try:
            await self.page.wait_for_selector(selector, timeout=timeout)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def screenshot(self, path: Optional[str] = None) -> Dict[str, Any]:
        """Take a screenshot"""
        try:
            if path:
                await self.page.screenshot(path=path)
                return {"success": True, "path": path}
            else:
                screenshot_bytes = await self.page.screenshot()
                screenshot_b64 = base64.b64encode(screenshot_bytes).decode()
                return {"success": True, "screenshot": screenshot_b64}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def get_url(self) -> str:
        """Get current page URL"""
        return self.page.url

    async def get_title(self) -> str:
        """Get page title"""
        return await self.page.title()

    async def close(self):
        """Close browser"""
        if self.context:
            await self.context.close()
        if self.browser:
            await self.browser.close()
        if self.playwright:
            await self.playwright.stop()


# Singleton instance
_playwright_tool: Optional[PlaywrightTool] = None


def get_playwright_tool(headless: bool = True, browser: str = "chromium") -> PlaywrightTool:
    """Get or create Playwright tool instance"""
    global _playwright_tool
    if _playwright_tool is None:
        _playwright_tool = PlaywrightTool(headless=headless, browser=browser)
    return _playwright_tool

