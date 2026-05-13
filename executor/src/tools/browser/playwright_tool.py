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

    # ------------------------------------------------------------------
    # Salesforce-specific helpers
    # ------------------------------------------------------------------

    async def salesforce_login(
        self,
        url: str,
        username: str,
        password: str,
        timeout: int = 60000,
    ) -> Dict[str, Any]:
        """Log into Salesforce using standard login form.

        Handles both Classic and Lightning login pages and waits for the
        Lightning App Launcher to confirm successful login.
        """
        try:
            await self.page.goto(url, wait_until="networkidle", timeout=timeout)

            # Fill username
            await self.page.fill("#username", username, timeout=timeout)
            await self.page.fill("#password", password, timeout=timeout)
            await self.page.click("#Login", timeout=timeout)

            # Wait for Lightning shell or Classic home page
            await self.page.wait_for_selector(
                "one-app-nav-bar, .slds-icon-waffle, #home_Tab, .homeTab",
                timeout=timeout,
            )

            return {"success": True, "url": self.page.url}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def wait_for_lightning(self, timeout: int = 30000) -> Dict[str, Any]:
        """Wait for Salesforce Lightning Experience to finish rendering.

        Polls until the aura-loading overlay disappears and the main
        Lightning container is interactive.
        """
        try:
            # Dismiss loading spinner if present
            await self.page.wait_for_function(
                """() => {
                    const spinner = document.querySelector('.slds-spinner_container, .auraLoadingBox');
                    return !spinner || spinner.style.display === 'none' || spinner.hidden;
                }""",
                timeout=timeout,
            )
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def get_lightning_component(
        self, selector: str, timeout: int = 30000
    ) -> Dict[str, Any]:
        """Retrieve a Salesforce Lightning Web Component (LWC) element.

        LWC components may be inside shadow roots, so this helper evaluates
        the selector through the regular DOM and pierces shadow roots where
        necessary using the ``>>`` deep combinator supported by Playwright.
        """
        try:
            # Playwright's page.locator supports deep combinators natively
            locator = self.page.locator(selector)
            await locator.wait_for(state="visible", timeout=timeout)
            text = await locator.text_content(timeout=timeout)
            return {"success": True, "text": text, "selector": selector}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def handle_classic_popup(self, action: str = "accept", timeout: int = 10000) -> Dict[str, Any]:
        """Handle Salesforce Classic alert/confirm popups.

        Args:
            action: ``"accept"`` to confirm or ``"dismiss"`` to cancel.
        """
        try:
            dialog_handled = False

            async def _handler(dialog):
                nonlocal dialog_handled
                if action == "accept":
                    await dialog.accept()
                else:
                    await dialog.dismiss()
                dialog_handled = True

            self.page.once("dialog", _handler)
            # Wait briefly for a dialog to appear
            await self.page.wait_for_timeout(timeout)

            return {"success": True, "handled": dialog_handled}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def salesforce_navigate_to_app(self, app_name: str, timeout: int = 30000) -> Dict[str, Any]:
        """Open a Salesforce app via the App Launcher."""
        try:
            # Click the App Launcher (waffle icon)
            await self.page.click(
                "one-app-nav-bar button[title='App Launcher'], .slds-icon-waffle",
                timeout=timeout,
            )
            # Search for the app
            search_box = self.page.locator(
                "one-app-launcher-modal input, input[placeholder='Search apps and items...']"
            )
            await search_box.wait_for(state="visible", timeout=timeout)
            await search_box.fill(app_name)
            # Click first matching result
            result = self.page.locator(
                f"one-app-launcher-desktop-item a[data-label='{app_name}'],"
                f" a:has-text('{app_name}')"
            ).first
            await result.click(timeout=timeout)
            await self.wait_for_lightning(timeout=timeout)
            return {"success": True, "app": app_name, "url": self.page.url}
        except Exception as e:
            return {"success": False, "error": str(e)}

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

