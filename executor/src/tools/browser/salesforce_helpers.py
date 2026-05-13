"""
Salesforce CRM Page Object helpers for Playwright-based test automation.

Provides reusable locator strategies for Salesforce Lightning Experience (LWC)
and Salesforce Classic, covering common CRM modules: Login, Leads, Contacts,
Opportunities, Cases, and Reports.
"""

from typing import Dict, Any, Optional
from .playwright_tool import PlaywrightTool


# ---------------------------------------------------------------------------
# Salesforce Locator Constants
# ---------------------------------------------------------------------------

class SalesforceLocators:
    """Centralised CSS / ARIA locators for Salesforce UI elements."""

    # --- Login page ---
    USERNAME_INPUT = "#username"
    PASSWORD_INPUT = "#password"
    LOGIN_BUTTON = "#Login"

    # --- Global navigation ---
    APP_LAUNCHER_BUTTON = "one-app-nav-bar button[title='App Launcher'], .slds-icon-waffle"
    APP_SEARCH_INPUT = "one-app-launcher-modal input[placeholder*='Search'], input[placeholder*='Search apps']"
    GLOBAL_SEARCH_INPUT = "input.global-search-input, input[placeholder*='Search Salesforce']"
    NEW_BUTTON = "a[title='New'], button[name='New'], lightning-button-group a:has-text('New')"
    SAVE_BUTTON = "button[name='SaveEdit'], button[title='Save']"
    CANCEL_BUTTON = "button[name='CancelEdit'], button[title='Cancel']"

    # --- Loading indicators ---
    LIGHTNING_SPINNER = ".slds-spinner_container, .auraLoadingBox, lightning-spinner"

    # --- List views ---
    LIST_VIEW_TABLE = "table.slds-table"
    LIST_VIEW_ROW = "table.slds-table tr[data-row-key-value]"
    LIST_VIEW_FIRST_ROW_LINK = "table.slds-table tr:first-of-type a[data-refid='recordId']"

    # --- Record form fields (Lightning) ---
    FIELD_LABEL = "records-record-layout-item .slds-form-element__label"
    FIELD_VALUE = "records-record-layout-item .slds-form-element__static"
    INPUT_FIELD = "records-record-layout-item input, records-record-layout-item textarea"

    # --- Leads ---
    LEAD_FIRST_NAME = "input[placeholder='First Name'], input[field-label='First Name']"
    LEAD_LAST_NAME = "input[placeholder='Last Name'], input[field-label='Last Name']"
    LEAD_COMPANY = "input[placeholder='Company'], input[field-label='Company']"
    LEAD_STATUS = "select[placeholder='Status'], lightning-combobox[field-name='Status']"

    # --- Contacts ---
    CONTACT_FIRST_NAME = "input[placeholder='First Name'], input[field-label='First Name']"
    CONTACT_LAST_NAME = "input[placeholder='Last Name'], input[field-label='Last Name']"
    CONTACT_ACCOUNT = "input[placeholder='Account Name'], input[field-label='Account Name']"
    CONTACT_EMAIL = "input[placeholder='Email'], input[field-label='Email']"

    # --- Opportunities ---
    OPP_NAME = "input[placeholder='Opportunity Name'], input[field-label='Opportunity Name']"
    OPP_STAGE = "lightning-combobox[field-name='StageName']"
    OPP_CLOSE_DATE = "input[placeholder='Close Date'], input[field-label='Close Date']"
    OPP_AMOUNT = "input[placeholder='Amount'], input[field-label='Amount']"

    # --- Cases ---
    CASE_SUBJECT = "input[placeholder='Subject'], input[field-label='Subject']"
    CASE_STATUS = "lightning-combobox[field-name='Status']"
    CASE_PRIORITY = "lightning-combobox[field-name='Priority']"
    CASE_DESCRIPTION = "textarea[placeholder='Description'], textarea[field-label='Description']"

    # --- Reports ---
    REPORT_NAME = "input[placeholder='Report Name'], h1.report-name"
    RUN_REPORT_BUTTON = "button[title='Run Report'], button:has-text('Run Report')"
    REPORT_TABLE = "table.reportTable, table.slds-table"


# ---------------------------------------------------------------------------
# Base Salesforce Page Object
# ---------------------------------------------------------------------------

class SalesforcePage:
    """Base class for Salesforce page objects."""

    def __init__(self, tool: PlaywrightTool):
        self.tool = tool

    @property
    def page(self):
        return self.tool.page


# ---------------------------------------------------------------------------
# Login Page Object
# ---------------------------------------------------------------------------

class SalesforceLoginPage(SalesforcePage):
    """Page object for the Salesforce login page."""

    async def login(self, url: str, username: str, password: str, timeout: int = 60000) -> Dict[str, Any]:
        """Navigate to the login URL and authenticate."""
        return await self.tool.salesforce_login(url, username, password, timeout)


# ---------------------------------------------------------------------------
# Navigation Helper
# ---------------------------------------------------------------------------

class SalesforceNavigator(SalesforcePage):
    """Helpers for navigating around Salesforce Lightning Experience."""

    async def open_app(self, app_name: str, timeout: int = 30000) -> Dict[str, Any]:
        """Open a Salesforce app via the App Launcher."""
        return await self.tool.salesforce_navigate_to_app(app_name, timeout)

    async def open_module(self, module_url_slug: str, base_url: str, timeout: int = 30000) -> Dict[str, Any]:
        """Navigate directly to a Salesforce module by URL slug (e.g. 'Lead/o')."""
        url = f"{base_url.rstrip('/')}/lightning/o/{module_url_slug}/list"
        return await self.tool.navigate(url)

    async def create_new_record(self, timeout: int = 30000) -> Dict[str, Any]:
        """Click the 'New' button to start creating a record."""
        return await self.tool.click(SalesforceLocators.NEW_BUTTON, timeout)

    async def save_record(self, timeout: int = 30000) -> Dict[str, Any]:
        """Save the current record form."""
        result = await self.tool.click(SalesforceLocators.SAVE_BUTTON, timeout)
        if result["success"]:
            await self.tool.wait_for_lightning(timeout)
        return result

    async def cancel_record(self, timeout: int = 30000) -> Dict[str, Any]:
        """Cancel the current record form."""
        return await self.tool.click(SalesforceLocators.CANCEL_BUTTON, timeout)


# ---------------------------------------------------------------------------
# Leads Page Object
# ---------------------------------------------------------------------------

class SalesforceLeadPage(SalesforcePage):
    """Page object for Salesforce Leads module."""

    async def navigate_to_leads(self, base_url: str) -> Dict[str, Any]:
        url = f"{base_url.rstrip('/')}/lightning/o/Lead/list"
        return await self.tool.navigate(url)

    async def create_lead(
        self,
        first_name: str,
        last_name: str,
        company: str,
        **kwargs,
    ) -> Dict[str, Any]:
        """Create a new Lead record. ``kwargs`` can include any extra fields."""
        nav = SalesforceNavigator(self.tool)
        await nav.create_new_record()
        await self.tool.wait_for_lightning()

        await self.tool.fill(SalesforceLocators.LEAD_FIRST_NAME, first_name)
        await self.tool.fill(SalesforceLocators.LEAD_LAST_NAME, last_name)
        await self.tool.fill(SalesforceLocators.LEAD_COMPANY, company)

        for field_selector, value in kwargs.items():
            await self.tool.fill(field_selector, value)

        return await nav.save_record()

    async def find_lead_by_name(self, name: str, timeout: int = 30000) -> Dict[str, Any]:
        """Search for a lead by name using global search."""
        await self.tool.fill(SalesforceLocators.GLOBAL_SEARCH_INPUT, name)
        await self.tool.page.keyboard.press("Enter")
        await self.tool.wait_for_lightning(timeout)
        return await self.tool.get_text(SalesforceLocators.LIST_VIEW_FIRST_ROW_LINK, timeout)


# ---------------------------------------------------------------------------
# Contacts Page Object
# ---------------------------------------------------------------------------

class SalesforceContactPage(SalesforcePage):
    """Page object for Salesforce Contacts module."""

    async def navigate_to_contacts(self, base_url: str) -> Dict[str, Any]:
        url = f"{base_url.rstrip('/')}/lightning/o/Contact/list"
        return await self.tool.navigate(url)

    async def create_contact(
        self,
        first_name: str,
        last_name: str,
        email: Optional[str] = None,
        account_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        nav = SalesforceNavigator(self.tool)
        await nav.create_new_record()
        await self.tool.wait_for_lightning()

        await self.tool.fill(SalesforceLocators.CONTACT_FIRST_NAME, first_name)
        await self.tool.fill(SalesforceLocators.CONTACT_LAST_NAME, last_name)
        if email:
            await self.tool.fill(SalesforceLocators.CONTACT_EMAIL, email)
        if account_name:
            await self.tool.fill(SalesforceLocators.CONTACT_ACCOUNT, account_name)

        return await nav.save_record()


# ---------------------------------------------------------------------------
# Opportunities Page Object
# ---------------------------------------------------------------------------

class SalesforceOpportunityPage(SalesforcePage):
    """Page object for Salesforce Opportunities module."""

    async def navigate_to_opportunities(self, base_url: str) -> Dict[str, Any]:
        url = f"{base_url.rstrip('/')}/lightning/o/Opportunity/list"
        return await self.tool.navigate(url)

    async def create_opportunity(
        self,
        name: str,
        stage: str,
        close_date: str,
        amount: Optional[str] = None,
    ) -> Dict[str, Any]:
        nav = SalesforceNavigator(self.tool)
        await nav.create_new_record()
        await self.tool.wait_for_lightning()

        await self.tool.fill(SalesforceLocators.OPP_NAME, name)
        await self.tool.select_option(SalesforceLocators.OPP_STAGE, stage)
        await self.tool.fill(SalesforceLocators.OPP_CLOSE_DATE, close_date)
        if amount:
            await self.tool.fill(SalesforceLocators.OPP_AMOUNT, amount)

        return await nav.save_record()


# ---------------------------------------------------------------------------
# Cases Page Object
# ---------------------------------------------------------------------------

class SalesforceCasePage(SalesforcePage):
    """Page object for Salesforce Cases module."""

    async def navigate_to_cases(self, base_url: str) -> Dict[str, Any]:
        url = f"{base_url.rstrip('/')}/lightning/o/Case/list"
        return await self.tool.navigate(url)

    async def create_case(
        self,
        subject: str,
        status: str = "New",
        priority: str = "Medium",
        description: Optional[str] = None,
    ) -> Dict[str, Any]:
        nav = SalesforceNavigator(self.tool)
        await nav.create_new_record()
        await self.tool.wait_for_lightning()

        await self.tool.fill(SalesforceLocators.CASE_SUBJECT, subject)
        await self.tool.select_option(SalesforceLocators.CASE_STATUS, status)
        await self.tool.select_option(SalesforceLocators.CASE_PRIORITY, priority)
        if description:
            await self.tool.fill(SalesforceLocators.CASE_DESCRIPTION, description)

        return await nav.save_record()


# ---------------------------------------------------------------------------
# Factory helper
# ---------------------------------------------------------------------------

def get_salesforce_pages(tool: PlaywrightTool) -> Dict[str, Any]:
    """Return a dict of all Salesforce page objects for a given tool instance."""
    return {
        "login": SalesforceLoginPage(tool),
        "navigator": SalesforceNavigator(tool),
        "leads": SalesforceLeadPage(tool),
        "contacts": SalesforceContactPage(tool),
        "opportunities": SalesforceOpportunityPage(tool),
        "cases": SalesforceCasePage(tool),
    }
