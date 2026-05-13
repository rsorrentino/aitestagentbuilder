"""
Test Runner
Main entry point for executing test cases
"""

import asyncio
import sys
import json
import argparse
import os
from datetime import datetime
from typing import Dict, Any, List
import psycopg2
from dotenv import load_dotenv

from ..agents.execution_agent import ExecutionAgent
from ..agents.validation_agent import ValidationAgent

load_dotenv()


class TestRunner:
    def __init__(self, run_id: str, agent_config: Dict[str, Any], test_ids: List[str]):
        self.run_id = run_id
        self.agent_config = agent_config
        self.test_ids = test_ids
        self.execution_agent = ExecutionAgent(agent_config)
        self.validation_agent = ValidationAgent()
        self.db_url = os.getenv("DB_URL", "postgresql://postgres:password@localhost:5432/aitestagentbuilder")

    async def run(self):
        """Execute all test cases"""
        await self.execution_agent.initialize()

        try:
            for test_id in self.test_ids:
                await self.run_test_case(test_id)
        finally:
            await self.execution_agent.cleanup()

    async def run_test_case(self, test_case_id: str):
        """Execute a single test case"""
        # Fetch test case from database
        test_case = self.fetch_test_case(test_case_id)
        if not test_case:
            print(f"Test case {test_case_id} not found")
            return

        # Create result record
        result_id = self.create_result(test_case_id)

        try:
            logs = []
            step_results = []
            evidence = {"screenshots": [], "logs": []}

            # Execute preconditions if any
            if test_case.get("preconditions"):
                logs.append("Executing preconditions...")
                # TODO: Execute preconditions

            # Execute test steps
            for step in test_case.get("steps", []):
                step_id = step.get("stepId", 0)
                action = step.get("action", "")
                target = step.get("target", "")
                data = step.get("data", {})

                logs.append(f"Step {step_id}: {action}")

                # Execute step
                step_result = await self.execution_agent.execute_step(step, {})
                step_results.append(step_result)

                # Validate step if expected result provided
                if step.get("expectedResult"):
                    validation = self.validation_agent.validate(
                        step_result,
                        step.get("expectedResult"),
                        step_id
                    )
                    if not validation["passed"]:
                        logs.append(f"Validation failed: {validation['message']}")

                # Capture screenshot on failure
                if not step_result.get("success"):
                    screenshot_result = await self.execution_agent.execute_step(
                        {"action": "screenshot", "target": "", "data": {}},
                        {}
                    )
                    if screenshot_result.get("screenshot"):
                        evidence["screenshots"].append(screenshot_result["screenshot"])

            # Validate final expected results
            expected_results = test_case.get("expectedResults", [])
            final_validation = self.validation_agent.validate_final_results(
                expected_results,
                step_results
            )

            # Determine test status
            all_steps_passed = all(r.get("success", False) for r in step_results)
            all_validations_passed = final_validation.get("all_passed", False)
            test_status = "passed" if (all_steps_passed and all_validations_passed) else "failed"

            # Update result
            self.update_result(
                result_id,
                test_status,
                logs,
                evidence,
                self.validation_agent.validation_results
            )

            print(f"Test case {test_case_id}: {test_status}")

        except Exception as e:
            self.update_result(result_id, "error", [str(e)], {}, [])
            print(f"Test case {test_case_id} failed with error: {e}")

    def fetch_test_case(self, test_case_id: str) -> Dict[str, Any]:
        """Fetch test case from database"""
        conn = psycopg2.connect(self.db_url)
        try:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM test_cases WHERE id = %s", (test_case_id,))
            row = cursor.fetchone()
            if row:
                columns = [desc[0] for desc in cursor.description]
                test_case = dict(zip(columns, row))
                # Parse JSON fields
                for field in ["steps", "expected_results", "preconditions", "postconditions", "tags", "data", "metadata"]:
                    if test_case.get(field) and isinstance(test_case[field], str):
                        test_case[field] = json.loads(test_case[field])
                return test_case
            return None
        finally:
            conn.close()

    def create_result(self, test_case_id: str) -> str:
        """Create result record in database"""
        result_id = f"RESULT-{datetime.now().timestamp()}-{test_case_id}"
        conn = psycopg2.connect(self.db_url)
        try:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO results (id, run_id, test_case_id, status, started_at)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (result_id, self.run_id, test_case_id, "running", datetime.now())
            )
            conn.commit()
            return result_id
        finally:
            conn.close()

    def update_result(self, result_id: str, status: str, logs: List[str], evidence: Dict, validation_results: List[Dict]):
        """Update result record in database"""
        conn = psycopg2.connect(self.db_url)
        try:
            cursor = conn.cursor()
            cursor.execute(
                """
                UPDATE results
                SET status = %s, finished_at = %s, logs = %s, evidence = %s, validation_results = %s
                WHERE id = %s
                """,
                (
                    status,
                    datetime.now(),
                    json.dumps(logs),
                    json.dumps(evidence),
                    json.dumps(validation_results),
                    result_id,
                )
            )
            conn.commit()
        finally:
            conn.close()


async def main():
    parser = argparse.ArgumentParser(description="AI Test Agent Runner")
    parser.add_argument("--run-id", required=True, help="Test run ID")
    parser.add_argument("--agent-config", required=True, help="Agent configuration JSON")
    parser.add_argument("--test-ids", required=True, help="Comma-separated test case IDs")

    args = parser.parse_args()

    agent_config = json.loads(args.agent_config)
    test_ids = args.test_ids.split(",")

    runner = TestRunner(args.run_id, agent_config, test_ids)
    await runner.run()


if __name__ == "__main__":
    asyncio.run(main())

