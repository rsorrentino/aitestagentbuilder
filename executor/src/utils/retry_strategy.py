"""
Advanced Retry Strategy
Implements exponential backoff and configurable retry logic
"""

import asyncio
import time
from typing import Callable, Any, Optional, Dict
from enum import Enum


class RetryStrategy(Enum):
    EXPONENTIAL = "exponential"
    LINEAR = "linear"
    FIXED = "fixed"
    CUSTOM = "custom"


class RetryConfig:
    def __init__(
        self,
        max_retries: int = 3,
        initial_delay: float = 1.0,
        max_delay: float = 60.0,
        multiplier: float = 2.0,
        strategy: RetryStrategy = RetryStrategy.EXPONENTIAL,
        retryable_errors: Optional[list] = None,
    ):
        self.max_retries = max_retries
        self.initial_delay = initial_delay
        self.max_delay = max_delay
        self.multiplier = multiplier
        self.strategy = strategy
        self.retryable_errors = retryable_errors or []


class RetryHandler:
    def __init__(self, config: RetryConfig):
        self.config = config

    async def execute_with_retry(
        self,
        func: Callable,
        *args,
        **kwargs
    ) -> Dict[str, Any]:
        """Execute function with retry logic"""
        last_error = None
        attempt = 0

        while attempt <= self.config.max_retries:
            try:
                if asyncio.iscoroutinefunction(func):
                    result = await func(*args, **kwargs)
                else:
                    result = func(*args, **kwargs)

                # Check if result indicates failure
                if isinstance(result, dict) and not result.get("success", True):
                    if attempt < self.config.max_retries:
                        delay = self._calculate_delay(attempt)
                        await self._wait(delay)
                        attempt += 1
                        continue
                    return result

                return {"success": True, "result": result, "attempts": attempt + 1}

            except Exception as e:
                last_error = e
                error_type = type(e).__name__

                # Check if error is retryable
                if not self._is_retryable_error(e):
                    return {
                        "success": False,
                        "error": str(e),
                        "error_type": error_type,
                        "attempts": attempt + 1,
                    }

                if attempt < self.config.max_retries:
                    delay = self._calculate_delay(attempt)
                    await self._wait(delay)
                    attempt += 1
                else:
                    break

        return {
            "success": False,
            "error": str(last_error) if last_error else "Max retries exceeded",
            "attempts": attempt + 1,
        }

    def _is_retryable_error(self, error: Exception) -> bool:
        """Check if error is retryable"""
        if not self.config.retryable_errors:
            return True  # Retry all errors by default

        error_type = type(error).__name__
        return error_type in self.config.retryable_errors

    def _calculate_delay(self, attempt: int) -> float:
        """Calculate delay based on retry strategy"""
        if self.config.strategy == RetryStrategy.EXPONENTIAL:
            delay = self.config.initial_delay * (self.config.multiplier ** attempt)
        elif self.config.strategy == RetryStrategy.LINEAR:
            delay = self.config.initial_delay * (attempt + 1)
        elif self.config.strategy == RetryStrategy.FIXED:
            delay = self.config.initial_delay
        else:
            delay = self.config.initial_delay

        return min(delay, self.config.max_delay)

    async def _wait(self, delay: float):
        """Wait for specified delay"""
        await asyncio.sleep(delay)


def create_retry_handler(
    max_retries: int = 3,
    initial_delay: float = 1.0,
    strategy: str = "exponential"
) -> RetryHandler:
    """Factory function to create retry handler"""
    retry_strategy = RetryStrategy(strategy)
    config = RetryConfig(
        max_retries=max_retries,
        initial_delay=initial_delay,
        strategy=retry_strategy,
    )
    return RetryHandler(config)

