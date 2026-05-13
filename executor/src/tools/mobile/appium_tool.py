"""
Appium Mobile Tool
Handles mobile app automation
"""

from appium import webdriver
from appium.options.common import AppiumOptions
from typing import Dict, Any, Optional


class AppiumTool:
    def __init__(self, server_url: str = "http://localhost:4723"):
        self.server_url = server_url
        self.driver: Optional[webdriver.Remote] = None
        self.capabilities: Dict[str, Any] = {}

    def set_capabilities(self, capabilities: Dict[str, Any]):
        """Set Appium capabilities"""
        self.capabilities = capabilities

    def initialize(self, platform: str = "android", **kwargs):
        """Initialize Appium driver"""
        options = AppiumOptions()
        
        # Set platform-specific capabilities
        if platform.lower() == "android":
            options.platform_name = "Android"
            options.device_name = kwargs.get("device_name", "Android Emulator")
            options.app_package = kwargs.get("app_package")
            options.app_activity = kwargs.get("app_activity")
            if kwargs.get("app_path"):
                options.app = kwargs.get("app_path")
        elif platform.lower() == "ios":
            options.platform_name = "iOS"
            options.device_name = kwargs.get("device_name", "iPhone Simulator")
            options.bundle_id = kwargs.get("bundle_id")
            if kwargs.get("app_path"):
                options.app = kwargs.get("app_path")

        # Merge additional capabilities
        for key, value in kwargs.items():
            if key not in ["device_name", "app_package", "app_activity", "app_path", "bundle_id"]:
                setattr(options, key, value)

        self.driver = webdriver.Remote(self.server_url, options=options)
        return {"success": True}

    def click(self, element_id: str, by: str = "id") -> Dict[str, Any]:
        """Click an element"""
        try:
            if by == "id":
                element = self.driver.find_element("id", element_id)
            elif by == "xpath":
                element = self.driver.find_element("xpath", element_id)
            elif by == "accessibility_id":
                element = self.driver.find_element("accessibility id", element_id)
            else:
                return {"success": False, "error": f"Unsupported locator: {by}"}

            element.click()
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def send_keys(self, element_id: str, text: str, by: str = "id") -> Dict[str, Any]:
        """Send text to an element"""
        try:
            if by == "id":
                element = self.driver.find_element("id", element_id)
            elif by == "xpath":
                element = self.driver.find_element("xpath", element_id)
            elif by == "accessibility_id":
                element = self.driver.find_element("accessibility id", element_id)
            else:
                return {"success": False, "error": f"Unsupported locator: {by}"}

            element.send_keys(text)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def get_text(self, element_id: str, by: str = "id") -> Dict[str, Any]:
        """Get text from an element"""
        try:
            if by == "id":
                element = self.driver.find_element("id", element_id)
            elif by == "xpath":
                element = self.driver.find_element("xpath", element_id)
            elif by == "accessibility_id":
                element = self.driver.find_element("accessibility id", element_id)
            else:
                return {"success": False, "error": f"Unsupported locator: {by}"}

            text = element.text
            return {"success": True, "text": text}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def swipe(self, start_x: int, start_y: int, end_x: int, end_y: int, duration: int = 1000) -> Dict[str, Any]:
        """Perform swipe gesture"""
        try:
            self.driver.swipe(start_x, start_y, end_x, end_y, duration)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def screenshot(self, path: Optional[str] = None) -> Dict[str, Any]:
        """Take a screenshot"""
        try:
            screenshot_bytes = self.driver.get_screenshot_as_png()
            if path:
                with open(path, "wb") as f:
                    f.write(screenshot_bytes)
                return {"success": True, "path": path}
            else:
                import base64
                screenshot_b64 = base64.b64encode(screenshot_bytes).decode()
                return {"success": True, "screenshot": screenshot_b64}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def close(self):
        """Close driver"""
        if self.driver:
            self.driver.quit()


# Singleton instance
_appium_tool: Optional[AppiumTool] = None


def get_appium_tool(server_url: str = "http://localhost:4723") -> AppiumTool:
    """Get or create Appium tool instance"""
    global _appium_tool
    if _appium_tool is None:
        _appium_tool = AppiumTool(server_url=server_url)
    return _appium_tool

