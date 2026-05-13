"""
HTTP API Tool
Handles API requests using requests library
"""

import requests
from typing import Dict, Any, Optional
import json


class HTTPTool:
    def __init__(self, base_url: Optional[str] = None, timeout: int = 30):
        self.base_url = base_url
        self.timeout = timeout
        self.session = requests.Session()

    def set_headers(self, headers: Dict[str, str]):
        """Set default headers"""
        self.session.headers.update(headers)

    def set_auth(self, auth_type: str, credentials: Dict[str, str]):
        """Set authentication"""
        if auth_type == "bearer":
            self.session.headers["Authorization"] = f"Bearer {credentials.get('token')}"
        elif auth_type == "basic":
            from requests.auth import HTTPBasicAuth
            self.session.auth = HTTPBasicAuth(
                credentials.get("username", ""),
                credentials.get("password", "")
            )

    def get(self, endpoint: str, params: Optional[Dict] = None, headers: Optional[Dict] = None) -> Dict[str, Any]:
        """Perform GET request"""
        url = f"{self.base_url}{endpoint}" if self.base_url else endpoint
        try:
            response = self.session.get(url, params=params, headers=headers, timeout=self.timeout)
            return {
                "success": response.status_code < 400,
                "status_code": response.status_code,
                "headers": dict(response.headers),
                "body": self._parse_response(response),
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    def post(self, endpoint: str, data: Optional[Any] = None, json_data: Optional[Dict] = None, 
             headers: Optional[Dict] = None) -> Dict[str, Any]:
        """Perform POST request"""
        url = f"{self.base_url}{endpoint}" if self.base_url else endpoint
        try:
            response = self.session.post(
                url, data=data, json=json_data, headers=headers, timeout=self.timeout
            )
            return {
                "success": response.status_code < 400,
                "status_code": response.status_code,
                "headers": dict(response.headers),
                "body": self._parse_response(response),
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    def put(self, endpoint: str, data: Optional[Any] = None, json_data: Optional[Dict] = None,
            headers: Optional[Dict] = None) -> Dict[str, Any]:
        """Perform PUT request"""
        url = f"{self.base_url}{endpoint}" if self.base_url else endpoint
        try:
            response = self.session.put(
                url, data=data, json=json_data, headers=headers, timeout=self.timeout
            )
            return {
                "success": response.status_code < 400,
                "status_code": response.status_code,
                "headers": dict(response.headers),
                "body": self._parse_response(response),
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    def delete(self, endpoint: str, headers: Optional[Dict] = None) -> Dict[str, Any]:
        """Perform DELETE request"""
        url = f"{self.base_url}{endpoint}" if self.base_url else endpoint
        try:
            response = self.session.delete(url, headers=headers, timeout=self.timeout)
            return {
                "success": response.status_code < 400,
                "status_code": response.status_code,
                "headers": dict(response.headers),
                "body": self._parse_response(response),
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    def _parse_response(self, response: requests.Response) -> Any:
        """Parse response body"""
        try:
            return response.json()
        except:
            return response.text


# Singleton instance
_http_tool: Optional[HTTPTool] = None


def get_http_tool(base_url: Optional[str] = None) -> HTTPTool:
    """Get or create HTTP tool instance"""
    global _http_tool
    if _http_tool is None or (base_url and _http_tool.base_url != base_url):
        _http_tool = HTTPTool(base_url=base_url)
    return _http_tool

