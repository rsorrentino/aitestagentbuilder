"""
Validation Agent
Validates test results against expected outcomes
"""

from typing import Dict, Any, List
import re


class ValidationAgent:
    def __init__(self):
        self.validation_results: List[Dict[str, Any]] = []

    def validate(self, step_result: Dict[str, Any], expected_result: str, step_id: int) -> Dict[str, Any]:
        """Validate a step result against expected outcome"""
        success = step_result.get("success", False)
        
        # If step failed, validation fails
        if not success:
            return {
                "stepId": step_id,
                "expected": expected_result,
                "actual": step_result.get("error", "Step execution failed"),
                "passed": False,
                "message": f"Step execution failed: {step_result.get('error')}",
            }

        # Try different validation strategies
        validation_result = self._validate_expected(expected_result, step_result)
        
        result = {
            "stepId": step_id,
            "expected": expected_result,
            "actual": self._extract_actual(step_result),
            "passed": validation_result["passed"],
            "message": validation_result.get("message"),
        }

        self.validation_results.append(result)
        return result

    def _validate_expected(self, expected: str, actual_result: Dict[str, Any]) -> Dict[str, Any]:
        """Validate expected outcome using various strategies"""
        expected_lower = expected.lower()

        # Status code validation
        if "status code" in expected_lower or "status_code" in expected_lower:
            status_code = actual_result.get("status_code")
            if status_code:
                expected_code = self._extract_number(expected)
                return {
                    "passed": status_code == expected_code,
                    "message": f"Expected status code {expected_code}, got {status_code}",
                }

        # Text content validation
        if "contains" in expected_lower or "should contain" in expected_lower:
            text = actual_result.get("text") or str(actual_result.get("body", ""))
            search_text = self._extract_quoted_text(expected) or expected.split("contain")[-1].strip()
            passed = search_text.lower() in text.lower()
            return {
                "passed": passed,
                "message": f"Expected text '{search_text}' {'found' if passed else 'not found'}",
            }

        # URL validation
        if "url" in expected_lower or "redirect" in expected_lower:
            url = actual_result.get("url") or str(actual_result.get("body", ""))
            expected_url = self._extract_url(expected) or expected.split("url")[-1].strip()
            passed = expected_url.lower() in url.lower()
            return {
                "passed": passed,
                "message": f"Expected URL '{expected_url}' {'matches' if passed else 'does not match'}",
            }

        # Element visibility validation
        if "visible" in expected_lower or "displayed" in expected_lower:
            # For web, if we got text, element is likely visible
            text = actual_result.get("text")
            passed = text is not None and text != ""
            return {
                "passed": passed,
                "message": f"Element {'is visible' if passed else 'is not visible'}",
            }

        # Default: check if step succeeded
        return {
            "passed": actual_result.get("success", False),
            "message": "Step executed successfully",
        }

    def _extract_actual(self, result: Dict[str, Any]) -> str:
        """Extract actual value from result"""
        if result.get("text"):
            return result["text"]
        if result.get("status_code"):
            return f"Status code: {result['status_code']}"
        if result.get("url"):
            return f"URL: {result['url']}"
        if result.get("body"):
            return str(result["body"])
        return "Step executed"

    def _extract_number(self, text: str) -> int:
        """Extract number from text"""
        match = re.search(r'\d+', text)
        return int(match.group()) if match else 0

    def _extract_quoted_text(self, text: str) -> str:
        """Extract text within quotes"""
        match = re.search(r'["\']([^"\']+)["\']', text)
        return match.group(1) if match else ""

    def _extract_url(self, text: str) -> str:
        """Extract URL from text"""
        match = re.search(r'https?://[^\s]+', text)
        return match.group() if match else ""

    def validate_final_results(self, expected_results: List[str], execution_results: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Validate final expected results"""
        all_passed = all(
            any(self._validate_expected(exp, res)["passed"] for res in execution_results)
            for exp in expected_results
        )

        return {
            "all_passed": all_passed,
            "expected_count": len(expected_results),
            "validated_count": sum(
                1 for exp in expected_results
                if any(self._validate_expected(exp, res)["passed"] for res in execution_results)
            ),
        }

