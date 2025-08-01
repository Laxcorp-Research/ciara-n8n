import flow from 'lodash/flow';
import sortBy from 'lodash/sortBy';
import type {
	IExecuteFunctions,
	IHookFunctions,
	IDataObject,
	ILoadOptionsFunctions,
	JsonObject,
	IHttpRequestMethods,
	IRequestOptions,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import type {
	AllFields,
	CamelCaseResource,
	DateType,
	GetAllFilterOptions,
	IdType,
	LoadedFields,
	LoadedLayouts,
	LocationType,
	NameType,
	ProductDetails,
	ResourceItems,
	SnakeCaseResource,
	ZohoOAuth2ApiCredentials,
} from './types';

export function throwOnErrorStatus(
	this: IExecuteFunctions | IHookFunctions | ILoadOptionsFunctions,
	responseData: {
		data?: Array<{ status: string; message: string }>;
	},
) {
	if (responseData?.data?.[0].status === 'error') {
		throw new NodeOperationError(this.getNode(), responseData as Error);
	}
}

export async function zohoApiRequest(
	this: IExecuteFunctions | IHookFunctions | ILoadOptionsFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	body: IDataObject = {},
	qs: IDataObject = {},
	uri?: string,
) {
	const { oauthTokenData } = await this.getCredentials<ZohoOAuth2ApiCredentials>('zohoOAuth2Api');

	const options: IRequestOptions = {
		body: {
			data: [body],
		},
		method,
		qs,
		uri: uri || `${oauthTokenData.api_domain}/crm/v8${endpoint}`,
		json: true,
	};

	if (!Object.keys(body).length) {
		delete options.body;
	}

	if (!Object.keys(qs).length) {
		delete options.qs;
	}

	try {
		const responseData = await this.helpers.requestOAuth2?.call(this, 'zohoOAuth2Api', options);
		if (responseData === undefined) return [];
		throwOnErrorStatus.call(this, responseData as IDataObject);

		return responseData;
	} catch (error) {
		const args = error.cause?.data
			? {
					message: error.cause.data.message || 'The Zoho API returned an error.',
					description: JSON.stringify(error.cause.data, null, 2),
				}
			: undefined;
		throw new NodeApiError(this.getNode(), error as JsonObject, args);
	}
}

/**
 * Make an authenticated API request to Zoho CRM API and return all items.
 */
export async function zohoApiRequestAllItems(
	this: IHookFunctions | IExecuteFunctions | ILoadOptionsFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	body: IDataObject = {},
	qs: IDataObject = {},
	limit?: number,
) {
	const returnData: IDataObject[] = [];

	let responseData;
	qs.per_page = limit || 200;
	qs.page = 1;
	do {
		responseData = await zohoApiRequest.call(this, method, endpoint, body, qs);
		if (Array.isArray(responseData) && !responseData.length) return returnData;
		returnData.push(...(responseData.data as IDataObject[]));
		qs.page++;
	} while (
		responseData.info.more_records !== undefined &&
		responseData.info.more_records === true &&
		(limit !== undefined ? returnData.length < limit : true)
	);
	return returnData;
}

/**
 * Handle a Zoho CRM API listing by returning all items or up to a limit.
 */
export async function handleListing(
	this: IExecuteFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	body: IDataObject = {},
	qs: IDataObject = {},
) {
	const returnAll = this.getNodeParameter('returnAll', 0);
	const limit = this.getNodeParameter('limit', 0, 200);

	if (returnAll) {
		return await zohoApiRequestAllItems.call(this, method, endpoint, body, qs);
	}

	return await zohoApiRequestAllItems.call(this, method, endpoint, body, qs, limit);
}

export function throwOnEmptyUpdate(this: IExecuteFunctions, resource: CamelCaseResource) {
	throw new NodeOperationError(
		this.getNode(),
		`Please enter at least one field to update for the ${resource}.`,
	);
}

export function throwOnMissingProducts(
	this: IExecuteFunctions,
	resource: CamelCaseResource,
	productDetails: ProductDetails,
) {
	if (!productDetails.length) {
		throw new NodeOperationError(
			this.getNode(),
			`Please enter at least one product for the ${resource}.`,
		);
	}
}

// ----------------------------------------
//        required field adjusters
// ----------------------------------------

/**
 * Create a copy of an object without a specific property.
 */
const omit = (propertyToOmit: string, { [propertyToOmit]: _, ...remainingObject }) =>
	remainingObject;

/**
 * Place a product ID at a nested position in a product details field.
 */
export const adjustProductDetails = (productDetails: ProductDetails, operation?: string) => {
	return productDetails.map((p) => {
		const adjustedProduct = {
			product: { id: p.id },
			quantity: p.quantity || 1,
		};

		if (operation === 'upsert') {
			return { ...adjustedProduct, ...omit('id', p) };
		} else {
			return { ...adjustedProduct, ...omit('product', p) };
		}
	});
};

// ----------------------------------------
//        additional field adjusters
// ----------------------------------------

/**
 * Place a product ID at a nested position in a product details field.
 *
 * Only for updating products from Invoice, Purchase Order, Quote, and Sales Order.
 */
export const adjustProductDetailsOnUpdate = (allFields: AllFields) => {
	if (!allFields.Product_Details) return allFields;

	return allFields.Product_Details.map((p) => {
		return {
			...omit('product', p),
			product: { id: p.id },
			quantity: p.quantity || 1,
		};
	});
};

/**
 * Place a location field's contents at the top level of the payload.
 */
const adjustLocationFields = (locationType: LocationType) => (allFields: AllFields) => {
	const locationField = allFields[locationType];

	if (!locationField) return allFields;

	return {
		...omit(locationType, allFields),
		...locationField.address_fields,
	};
};

const adjustAddressFields = adjustLocationFields('Address');
const adjustBillingAddressFields = adjustLocationFields('Billing_Address');
const adjustMailingAddressFields = adjustLocationFields('Mailing_Address');
const adjustShippingAddressFields = adjustLocationFields('Shipping_Address');
const adjustOtherAddressFields = adjustLocationFields('Other_Address');

/**
 * Remove from a date field the timestamp set by the datepicker.
 */
const adjustDateField = (dateType: DateType) => (allFields: AllFields) => {
	const dateField = allFields[dateType];

	if (!dateField) return allFields;

	allFields[dateType] = dateField.split('T')[0];

	return allFields;
};

const adjustDateOfBirthField = adjustDateField('Date_of_Birth');
const adjustClosingDateField = adjustDateField('Closing_Date');
const adjustInvoiceDateField = adjustDateField('Invoice_Date');
const adjustDueDateField = adjustDateField('Due_Date');
const adjustPurchaseOrderDateField = adjustDateField('PO_Date');
const adjustValidTillField = adjustDateField('Valid_Till');

/**
 * Place an ID field's value nested inside the payload.
 */
const adjustIdField = (idType: IdType, nameProperty: NameType) => (allFields: AllFields) => {
	const idValue = allFields[idType];

	if (!idValue) return allFields;

	return {
		...omit(idType, allFields),
		[nameProperty]: { id: idValue },
	};
};

const adjustAccountIdField = adjustIdField('accountId', 'Account_Name');
const adjustContactIdField = adjustIdField('contactId', 'Full_Name');
const adjustDealIdField = adjustIdField('dealId', 'Deal_Name');

const adjustCustomFields = (allFields: AllFields) => {
	const { customFields, ...rest } = allFields;

	if (!customFields?.customFields.length) return allFields;

	return customFields.customFields.reduce((acc, cur) => {
		acc[cur.fieldId] = cur.value;
		return acc;
	}, rest);
};

// ----------------------------------------
//           payload adjusters
// ----------------------------------------

export const adjustAccountPayload = flow(
	adjustBillingAddressFields,
	adjustShippingAddressFields,
	adjustCustomFields,
);

export const adjustContactPayload = flow(
	adjustMailingAddressFields,
	adjustOtherAddressFields,
	adjustDateOfBirthField,
	adjustCustomFields,
);

export const adjustDealPayload = flow(adjustClosingDateField, adjustCustomFields);

export const adjustInvoicePayload = flow(
	adjustBillingAddressFields,
	adjustShippingAddressFields,
	adjustInvoiceDateField,
	adjustDueDateField,
	adjustAccountIdField,
	adjustCustomFields,
);

export const adjustInvoicePayloadOnUpdate = flow(
	adjustInvoicePayload,
	adjustProductDetailsOnUpdate,
);

export const adjustLeadPayload = flow(adjustAddressFields, adjustCustomFields);

export const adjustPurchaseOrderPayload = flow(
	adjustBillingAddressFields,
	adjustShippingAddressFields,
	adjustDueDateField,
	adjustPurchaseOrderDateField,
	adjustCustomFields,
);

export const adjustQuotePayload = flow(
	adjustBillingAddressFields,
	adjustShippingAddressFields,
	adjustValidTillField,
	adjustCustomFields,
);

export const adjustSalesOrderPayload = flow(
	adjustBillingAddressFields,
	adjustShippingAddressFields,
	adjustDueDateField,
	adjustAccountIdField,
	adjustContactIdField,
	adjustDealIdField,
	adjustCustomFields,
);

export const adjustVendorPayload = flow(adjustAddressFields, adjustCustomFields);

export const adjustProductPayload = adjustCustomFields;

// ----------------------------------------
//               helpers
// ----------------------------------------

/**
 * Convert items in a Zoho CRM API response into n8n load options.
 */
export const toLoadOptions = (items: ResourceItems, nameProperty: NameType) =>
	items.map((item) => ({ name: item[nameProperty], value: item.id }));

export function getModuleName(resource: string) {
	const map: { [key: string]: string } = {
		account: 'Accounts',
		contact: 'Contacts',
		deal: 'Deals',
		invoice: 'Invoices',
		lead: 'Leads',
		product: 'Products',
		purchaseOrder: 'Purchase_Orders',
		salesOrder: 'Sales_Orders',
		vendor: 'Vendors',
		quote: 'Quotes',
	};

	return map[resource];
}

/**
 * Retrieve all fields for a resource, sorted alphabetically.
 */

// Supported operators for each Zoho field type
const zohoSupportedOperators: Record<string, string[]> = {
	text: ['equals', 'not_equal', 'starts_with', 'in'],
	email: ['equals', 'not_equal', 'starts_with', 'in'],
	phone: ['equals', 'not_equal', 'starts_with', 'in'],
	website: ['equals', 'not_equal', 'starts_with', 'in'],
	picklist: ['equals', 'not_equal', 'in'],
	autonumber: ['equals', 'not_equal', 'in'],
	date: [
		'equals',
		'not_equal',
		'greater_equal',
		'greater_than',
		'less_equal',
		'less_than',
		'between',
		'in',
	],
	datetime: [
		'equals',
		'not_equal',
		'greater_equal',
		'greater_than',
		'less_equal',
		'less_than',
		'between',
		'in',
	],
	integer: [
		'equals',
		'not_equal',
		'greater_equal',
		'greater_than',
		'less_equal',
		'less_than',
		'between',
		'in',
	],
	currency: [
		'equals',
		'not_equal',
		'greater_equal',
		'greater_than',
		'less_equal',
		'less_than',
		'between',
		'in',
	],
	decimal: [
		'equals',
		'not_equal',
		'greater_equal',
		'greater_than',
		'less_equal',
		'less_than',
		'between',
		'in',
	],
	boolean: ['equals', 'not_equal'],
	textarea: ['equals', 'not_equal', 'starts_with'],
	lookup: ['equals', 'not_equal', 'in'],
	owner_lookup: ['equals', 'not_equal', 'in'],
	user_lookup: ['equals', 'not_equal', 'in'],
	multiselectpicklist: ['equals', 'not_equal', 'in', 'starts_with'],
	bigint: [
		'equals',
		'not_equal',
		'greater_than',
		'greater_equal',
		'less_than',
		'less_equal',
		'between',
		'in',
	],
	percent: [
		'equals',
		'not_equal',
		'greater_than',
		'greater_equal',
		'less_than',
		'less_equal',
		'between',
		'in',
	],
};

export async function getFields(
	this: ILoadOptionsFunctions,
	resource: SnakeCaseResource,
	{ onlyCustom } = { onlyCustom: false },
) {
	const qs = { module: getModuleName(resource) };

	let { fields } = (await zohoApiRequest.call(
		this,
		'GET',
		'/settings/fields',
		{},
		qs,
	)) as LoadedFields;

	if (onlyCustom) {
		fields = fields.filter(({ custom_field }) => custom_field);
	}

	// Return all field options, but attach supported operators for UI use
	const options = fields.map((field) => {
		const { field_label, api_name } = field;
		// Defensive: check for data_type property
		const dataType =
			typeof (field as any).data_type === 'string' ? (field as any).data_type : undefined;
		return {
			name: field_label,
			value: api_name,
			supportedOperators: dataType ? zohoSupportedOperators[dataType] || ['equals'] : ['equals'],
			data_type: dataType,
		};
	});

	return sortBy(options, (o) => o.name);
}

// Load supported operators for a given field (for dynamic dropdown)
export async function getFieldOperators(
	this: ILoadOptionsFunctions,
	field: string,
	resource: SnakeCaseResource,
) {
	try {
		const fields = await getFields.call(this, resource);
		const found = fields.find((f: any) => f.value === field);
		if (!found) return [{ name: 'Equals', value: 'equals' }];
		return (found.supportedOperators || ['equals']).map((op: string) => ({
			name: op.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
			value: op,
		}));
	} catch (error) {
		// Graceful fallback for UI: show only Equals if Zoho errors
		return [{ name: 'Equals', value: 'equals' }];
	}
}

// Helper to fetch all field API names for a resource in IExecuteFunctions context
export async function getFieldsForExecution(
	context: IExecuteFunctions,
	resource: SnakeCaseResource,
): Promise<string[]> {
	const qs = { module: getModuleName(resource) };
	const { fields } = (await zohoApiRequest.call(
		context,
		'GET',
		'/settings/fields',
		{},
		qs,
	)) as LoadedFields;
	return fields.map(({ api_name }) => api_name);
}

export const capitalizeInitial = (str: string) => str[0].toUpperCase() + str.slice(1);

function getSectionApiName(resource: string) {
	if (resource === 'purchaseOrder') return 'Purchase Order Information';
	if (resource === 'salesOrder') return 'Sales Order Information';

	return `${capitalizeInitial(resource)} Information`;
}

export async function getPicklistOptions(
	this: ILoadOptionsFunctions,
	resource: string,
	targetField: string,
) {
	const qs = { module: getModuleName(resource) };
	const responseData = (await zohoApiRequest.call(
		this,
		'GET',
		'/settings/layouts',
		{},
		qs,
	)) as LoadedLayouts;

	const pickListOptions = responseData.layouts[0].sections
		.find((section) => section.api_name === getSectionApiName(resource))
		?.fields.find((f) => f.api_name === targetField)?.pick_list_values;

	if (!pickListOptions) return [];

	return pickListOptions.map((option) => ({
		name: option.display_value,
		value: option.actual_value,
	}));
}

/**
 * Add filter options to a query string object.
 */
export const addGetAllFilterOptions = (qs: IDataObject, options: GetAllFilterOptions) => {
	if (Object.keys(options).length) {
		const { fields, ...rest } = options;
		Object.assign(qs, fields && { fields: fields.join(',') }, rest);
	}
};

// Helper to build Zoho search criteria string from filter builder
export function buildZohoCriteria(
	filters: Array<{ field: string; operator: string; value: any }>,
): string {
	if (!filters || !filters.length) return '';
	// Map UI operators to Zoho API operators
	const opMap: Record<string, string> = {
		equals: 'equals',
		not_equals: 'not_equal',
		contains: 'contains',
		not_contains: 'not_contains',
		starts_with: 'starts_with',
		ends_with: 'ends_with',
		greater_than: 'greater_than',
		less_than: 'less_than',
		greater_equal: 'greater_equal',
		less_equal: 'less_equal',
		between: 'between',
		in: 'in',
		is_empty: 'is_empty',
		is_not_empty: 'is_not_empty',
	};
	return filters
		.map((f) => {
			const op = opMap[f.operator] || 'equals';
			// For 'in', value should be comma-separated
			if (op === 'in' && Array.isArray(f.value)) {
				return `(${f.field}:${op}:${f.value.join(',')})`;
			}
			// For between, value should be two values separated by ","
			if (op === 'between' && Array.isArray(f.value) && f.value.length === 2) {
				return `(${f.field}:${op}:${f.value[0]},{f.value[1]})`;
			}
			// For is_empty/is_not_empty, no value
			if (op === 'is_empty' || op === 'is_not_empty') {
				return `(${f.field}:${op})`;
			}
			// Default
			return `(${f.field}:${op}:${f.value})`;
		})
		.join('and');
}

// Patch: Always require at least one filter for search, and always send criteria param
export async function zohoSearchWithCriteria(
	this: IExecuteFunctions,
	resource: SnakeCaseResource,
	filters: Array<{ field: string; operator: string; value: any }>,
	qs: IDataObject = {},
) {
	const criteria = buildZohoCriteria(filters);
	if (!criteria) {
		throw new NodeOperationError(this.getNode(), 'Please add at least one filter to search.');
	}
	qs.criteria = criteria;
	return zohoApiRequest.call(this, 'GET', `/${getModuleName(resource)}/search`, {}, qs);
}
