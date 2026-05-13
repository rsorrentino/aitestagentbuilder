"""
Self-Healing Agent
Uses an LLM (Claude or Copilot) to recover from failed Playwright selectors
by analysing the current page DOM and suggesting alternative locators.
"""

import os
import json
import asyncio
from typing import Dict, Any, Optional


class SelfHealingAgent:
    """Attempts to fix broken Playwright selectors using an AI provider.

    When a step fails with a ``TimeoutError`` or ``ElementNotFound`` error the
    agent:
    1. Takes a screenshot and captures a compact DOM snapshot.
    2. Sends the failed selector + DOM to the configured LLM provider.
    3. Returns the LLM-suggested replacement selector.
    """

    def __init__(self, provider: str = "claude", model: Optional[str] = None):
        self.provider = provider.lower()
        self.model = model or self._default_model()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def suggest_selector(
        self,
        page,
        failed_selector: str,
        action: str,
        context_description: str = "",
    ) -> Dict[str, Any]:
        """Suggest an alternative selector for a failed locator.

        Args:
            page: The Playwright ``Page`` object.
            failed_selector: The CSS/text selector that timed out.
            action: The action that was attempted (click, fill, etc.).
            context_description: Natural-language description of the step.

        Returns:
            ``{"success": True, "selector": "<new_selector>"}`` on success.
        """
        try:
            dom_snapshot = await self._capture_dom(page)
            prompt = self._build_prompt(failed_selector, action, dom_snapshot, context_description)
            llm_response = await self._call_llm(prompt)
            new_selector = self._extract_selector(llm_response)
            return {"success": True, "selector": new_selector, "rationale": llm_response}
        except Exception as e:
            return {"success": False, "error": str(e)}

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _default_model(self) -> str:
        models = {
            "claude": "claude-3-5-sonnet-latest",
            "copilot": "gpt-4o",
            "openai": "gpt-4o",
        }
        return models.get(self.provider, "claude-3-5-sonnet-latest")

    async def _capture_dom(self, page) -> str:
        """Return a compact HTML snapshot (body only, max 8000 chars)."""
        try:
            html: str = await page.evaluate(
                """() => {
                    const clone = document.body.cloneNode(true);
                    // Remove script/style noise
                    clone.querySelectorAll('script, style, svg').forEach(el => el.remove());
                    return clone.innerHTML.replace(/\\s+/g, ' ').substring(0, 8000);
                }"""
            )
            return html
        except Exception:
            return "<dom-capture-failed/>"

    def _build_prompt(
        self,
        failed_selector: str,
        action: str,
        dom_snapshot: str,
        context_description: str,
    ) -> str:
        return (
            "You are a Playwright test automation expert.\n"
            "A test step failed because the following CSS selector did not match any element:\n\n"
            f"Failed selector: {failed_selector}\n"
            f"Action attempted: {action}\n"
            f"Step context: {context_description}\n\n"
            "Here is a compact snapshot of the current page DOM:\n"
            f"```html\n{dom_snapshot}\n```\n\n"
            "Please analyse the DOM and suggest a SINGLE, valid CSS or ARIA selector that targets "
            "the intended element. Reply with ONLY a JSON object in this exact format:\n"
            '{"selector": "<your_suggested_selector>", "rationale": "<brief_explanation>"}\n'
        )

    def _extract_selector(self, llm_response: str) -> str:
        """Parse the LLM JSON response and return the selector string."""
        # Try JSON parse first
        try:
            data = json.loads(llm_response.strip())
            return data.get("selector", "")
        except json.JSONDecodeError:
            pass
        # Fallback: extract JSON-like pattern from response
        import re
        match = re.search(r'"selector"\s*:\s*"([^"]+)"', llm_response)
        if match:
            return match.group(1)
        # Last resort: return the raw response trimmed
        return llm_response.strip()

    async def _call_llm(self, prompt: str) -> str:
        """Call the configured LLM provider and return the text response."""
        if self.provider == "claude":
            return await self._call_anthropic(prompt)
        elif self.provider in ("copilot", "openai"):
            return await self._call_openai_compat(prompt)
        else:
            raise ValueError(f"Unsupported LLM provider for self-healing: {self.provider}")

    async def _call_anthropic(self, prompt: str) -> str:
        """Call Anthropic Claude Messages API."""
        import anthropic  # type: ignore

        api_key = os.getenv("ANTHROPIC_API_KEY", "")
        client = anthropic.Anthropic(api_key=api_key)

        message = client.messages.create(
            model=self.model,
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        return message.content[0].text if message.content else ""

    async def _call_openai_compat(self, prompt: str) -> str:
        """Call OpenAI-compatible endpoint (OpenAI or GitHub Copilot)."""
        import openai as _openai  # type: ignore

        if self.provider == "copilot":
            api_key = os.getenv("GITHUB_TOKEN", "")
            base_url = "https://api.githubcopilot.com"
        else:
            api_key = os.getenv("OPENAI_API_KEY", "")
            base_url = None

        client_kwargs: Dict[str, Any] = {"api_key": api_key}
        if base_url:
            client_kwargs["base_url"] = base_url

        client = _openai.AsyncOpenAI(**client_kwargs)

        response = await client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=512,
            temperature=0.2,
        )
        return response.choices[0].message.content or ""
