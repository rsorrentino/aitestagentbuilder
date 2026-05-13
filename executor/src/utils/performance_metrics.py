"""
Performance Metrics Collection
Collects performance data during test execution
"""

import time
from typing import Dict, Any, List, Optional
from datetime import datetime


class PerformanceMetrics:
    def __init__(self):
        self.metrics: Dict[str, Any] = {
            "start_time": None,
            "end_time": None,
            "duration": None,
            "network_requests": [],
            "page_load_times": [],
            "api_response_times": [],
            "memory_usage": [],
            "cpu_usage": [],
        }

    def start(self):
        """Start performance tracking"""
        self.metrics["start_time"] = datetime.now().isoformat()
        self.metrics["start_timestamp"] = time.time()

    def stop(self):
        """Stop performance tracking"""
        self.metrics["end_time"] = datetime.now().isoformat()
        if self.metrics.get("start_timestamp"):
            self.metrics["duration"] = time.time() - self.metrics["start_timestamp"]

    def record_network_request(
        self,
        url: str,
        method: str,
        status_code: int,
        response_time: float,
        size: Optional[int] = None,
    ):
        """Record network request metrics"""
        self.metrics["network_requests"].append({
            "url": url,
            "method": method,
            "status_code": status_code,
            "response_time": response_time,
            "size": size,
            "timestamp": datetime.now().isoformat(),
        })

    def record_page_load_time(self, page: str, load_time: float):
        """Record page load time"""
        self.metrics["page_load_times"].append({
            "page": page,
            "load_time": load_time,
            "timestamp": datetime.now().isoformat(),
        })

    def record_api_response_time(self, endpoint: str, response_time: float):
        """Record API response time"""
        self.metrics["api_response_times"].append({
            "endpoint": endpoint,
            "response_time": response_time,
            "timestamp": datetime.now().isoformat(),
        })

    def get_summary(self) -> Dict[str, Any]:
        """Get performance summary"""
        summary: Dict[str, Any] = {
            "total_duration": self.metrics.get("duration"),
            "network_requests_count": len(self.metrics["network_requests"]),
            "page_loads_count": len(self.metrics["page_load_times"]),
            "api_calls_count": len(self.metrics["api_response_times"]),
        }

        # Calculate averages
        if self.metrics["network_requests"]:
            avg_response_time = sum(
                r["response_time"] for r in self.metrics["network_requests"]
            ) / len(self.metrics["network_requests"])
            summary["avg_network_response_time"] = avg_response_time

        if self.metrics["page_load_times"]:
            avg_load_time = sum(
                p["load_time"] for p in self.metrics["page_load_times"]
            ) / len(self.metrics["page_load_times"])
            summary["avg_page_load_time"] = avg_load_time

        if self.metrics["api_response_times"]:
            avg_api_time = sum(
                a["response_time"] for a in self.metrics["api_response_times"]
            ) / len(self.metrics["api_response_times"])
            summary["avg_api_response_time"] = avg_api_time

        return summary

    def to_dict(self) -> Dict[str, Any]:
        """Convert metrics to dictionary"""
        return {
            **self.metrics,
            "summary": self.get_summary(),
        }

