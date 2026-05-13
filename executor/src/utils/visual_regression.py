"""
Visual Regression Testing
Compares screenshots and detects visual differences
"""

import base64
from typing import Dict, Any, Optional
from PIL import Image
import numpy as np
from io import BytesIO


class VisualRegressionTool:
    def __init__(self, threshold: float = 0.95):
        self.threshold = threshold  # Similarity threshold (0-1)

    def compare_screenshots(
        self,
        baseline: str,  # Base64 encoded image
        current: str,   # Base64 encoded image
    ) -> Dict[str, Any]:
        """Compare two screenshots"""
        try:
            baseline_img = self._decode_image(baseline)
            current_img = self._decode_image(current)

            # Resize if dimensions don't match
            if baseline_img.size != current_img.size:
                current_img = current_img.resize(baseline_img.size, Image.Resampling.LANCZOS)

            # Calculate similarity
            similarity = self._calculate_similarity(baseline_img, current_img)

            # Generate diff image if different
            diff_image = None
            if similarity < self.threshold:
                diff_image = self._generate_diff_image(baseline_img, current_img)

            return {
                "similar": similarity >= self.threshold,
                "similarity": similarity,
                "threshold": self.threshold,
                "diff_image": diff_image,
                "baseline_size": baseline_img.size,
                "current_size": current_img.size,
            }

        except Exception as e:
            return {
                "similar": False,
                "error": str(e),
            }

    def _decode_image(self, base64_str: str) -> Image.Image:
        """Decode base64 string to PIL Image"""
        image_data = base64.b64decode(base64_str)
        return Image.open(BytesIO(image_data))

    def _calculate_similarity(self, img1: Image.Image, img2: Image.Image) -> float:
        """Calculate similarity between two images using SSIM"""
        # Convert to numpy arrays
        arr1 = np.array(img1.convert("RGB"))
        arr2 = np.array(img2.convert("RGB"))

        # Normalize
        arr1 = arr1.astype(np.float32) / 255.0
        arr2 = arr2.astype(np.float32) / 255.0

        # Calculate SSIM (Structural Similarity Index)
        # Simplified version - in production use scikit-image's ssim
        diff = np.abs(arr1 - arr2)
        similarity = 1.0 - np.mean(diff)

        return max(0.0, min(1.0, similarity))

    def _generate_diff_image(
        self, baseline: Image.Image, current: Image.Image
    ) -> Optional[str]:
        """Generate difference image highlighting changes"""
        try:
            baseline_arr = np.array(baseline.convert("RGB"))
            current_arr = np.array(current.convert("RGB"))

            # Ensure same size
            if baseline_arr.shape != current_arr.shape:
                current_img = current.resize(baseline.size, Image.Resampling.LANCZOS)
                current_arr = np.array(current_img.convert("RGB"))

            # Calculate difference
            diff_arr = np.abs(baseline_arr.astype(np.int16) - current_arr.astype(np.int16))
            diff_arr = np.clip(diff_arr, 0, 255).astype(np.uint8)

            # Create diff image
            diff_img = Image.fromarray(diff_arr)

            # Convert to base64
            buffer = BytesIO()
            diff_img.save(buffer, format="PNG")
            diff_b64 = base64.b64encode(buffer.getvalue()).decode()

            return diff_b64

        except Exception as e:
            return None

    def validate_visual_regression(
        self,
        baseline_path: Optional[str],
        current_screenshot: str,
    ) -> Dict[str, Any]:
        """Validate visual regression"""
        if not baseline_path:
            return {
                "passed": True,
                "message": "No baseline image, skipping visual regression",
            }

        # Load baseline (assuming it's base64 encoded or file path)
        try:
            with open(baseline_path, "rb") as f:
                baseline_b64 = base64.b64encode(f.read()).decode()
        except:
            baseline_b64 = baseline_path  # Assume it's already base64

        comparison = self.compare_screenshots(baseline_b64, current_screenshot)

        return {
            "passed": comparison.get("similar", False),
            "similarity": comparison.get("similarity", 0),
            "diff_image": comparison.get("diff_image"),
            "message": "Visual regression check completed",
        }

