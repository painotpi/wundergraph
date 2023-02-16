import {
	ClaimConfig,
	ClaimType,
	CustomClaim,
	InjectVariableKind,
	OperationExecutionEngine,
	OperationRoleConfig,
	OperationType,
	VariableInjectionConfiguration,
} from '@wundergraph/protobuf';
import {
	buildSchema,
	ConstDirectiveNode,
	DirectiveNode,
	DocumentNode,
	FieldNode,
	FragmentDefinitionNode,
	GraphQLSchema,
	Kind,
	ObjectTypeDefinitionNode,
	OperationDefinitionNode,
	OperationTypeNode,
	parse,
	print,
	SelectionNode,
	stripIgnoredCharacters,
	TypeNode,
	UnionTypeDefinitionNode,
	validate,
	VariableDefinitionNode,
	visit,
} from 'graphql';
import { JSONSchema7 as JSONSchema } from 'json-schema';
import path from 'path';
import { WG_PRETTY_GRAPHQL_VALIDATION_ERRORS, WG_THROW_ON_OPERATION_LOADING_ERROR } from '../definition';
import { wunderctlExec } from '../wunderctlexec';
import { Logger } from '../logger';
import * as fs from 'fs';
import process from 'node:process';

export interface GraphQLOperation {
	Name: string;
	PathName: string;
	Content: string;
	OperationType: OperationType;
	ExecutionEngine: OperationExecutionEngine;
	VariablesSchema: JSONSchema;
	InterpolationVariablesSchema: JSONSchema;
	InjectedVariablesSchema: JSONSchema;
	InternalVariablesSchema: JSONSchema;
	ResponseSchema: JSONSchema;
	TypeScriptOperationImport?: string;
	Mock?: {
		Endpoint: string;
		SubscriptionPollingInterval?: number;
	};
	CacheConfig?: {
		enable: boolean;
		public: boolean;
		maxAge: number;
		staleWhileRevalidate: number;
	};
	LiveQuery?: {
		enable: boolean;
		pollingIntervalSeconds: number;
	};
	AuthenticationConfig: {
		required: boolean;
	};
	AuthorizationConfig: {
		claims: ClaimConfig[];
		roleConfig: OperationRoleConfig;
	};
	HooksConfiguration: {
		preResolve: boolean;
		postResolve: boolean;
		mutatingPreResolve: boolean;
		mutatingPostResolve: boolean;
		mockResolve: {
			enable: boolean;
			subscriptionPollingIntervalMillis: number;
		};
		httpTransportOnRequest: boolean;
		httpTransportOnResponse: boolean;
		customResolve: boolean;
	};
	VariablesConfiguration: {
		injectVariables: VariableInjectionConfiguration[];
	};
	Internal: boolean;
	PostResolveTransformations?: PostResolveTransformation[];
}

type PostResolveTransformation = PostResolveGetTransformation;

export interface BasePostResolveTransformation {
	depth: number;
}

export interface PostResolveGetTransformation extends BasePostResolveTransformation {
	kind: 'get';
	get: {
		from: string[];
		to: string[];
	};
}

export interface ParsedOperations {
	operations: GraphQLOperation[];
}

export interface ParseOperationsOptions {
	keepFromClaimVariables?: boolean;
	interpolateVariableDefinitionAsJSON?: string[];
	customJsonScalars?: string[];
	customClaims?: Record<string, CustomClaim>;
}

const defaultParseOptions: ParseOperationsOptions = {
	keepFromClaimVariables: false,
};

const defaultVariableInjectionConfiguration: Omit<
	Omit<VariableInjectionConfiguration, 'variableKind'>,
	'variablePathComponents'
> = {
	environmentVariableName: '',
	dateFormat: '',
};

export const parseGraphQLOperations = (
	graphQLSchema: string,
	loadOperationsOutput: LoadOperationsOutput,
	options: ParseOperationsOptions = defaultParseOptions
): ParsedOperations => {
	let parsedGraphQLSchema = buildSchema(graphQLSchema);
	if (parsedGraphQLSchema.getQueryType() === undefined) {
		parsedGraphQLSchema = buildSchema(graphQLSchema + ' type Query {hello: String}');
	}
	const parsed: ParsedOperations = {
		operations: [],
	};
	const wgRoleEnum = parsedGraphQLSchema.getType('WG_ROLE')?.astNode;
	loadOperationsOutput.graphql_operation_files?.forEach((operationFile) => {
		try {
			const ast = parse(operationFile.content);
			visit(ast, {
				OperationDefinition: {
					enter: (node) => {
						const content = print(node);
						const parsedOperation = parse(content);
						const operationWithoutHooksVariables = visit(parsedOperation, {
							VariableDefinition: {
								enter: (node) => {
									if (node.directives?.some((directive) => directive.name.value === 'hooksVariable')) {
										return null;
									}
								},
							},
						});
						const errors = validate(parsedGraphQLSchema, operationWithoutHooksVariables);
						if (errors.length > 0) {
							Logger.error(`Error parsing operation ${operationFile.file_path}: ${errors.join(',')}`);
							Logger.error('Skipping operation');
							if (WG_PRETTY_GRAPHQL_VALIDATION_ERRORS) {
								console.log('\n' + errors.join(',') + '\n');
							}
							return;
						}

						const transformations: PostResolveTransformation[] = [];

						const operation: GraphQLOperation = {
							Name: operationFile.operation_name,
							PathName: operationFile.api_mount_path,
							Content: stripIgnoredCharacters(removeTransformDirectives(content)),
							OperationType: parseOperationTypeNode(node.operation),
							ExecutionEngine: OperationExecutionEngine.ENGINE_GRAPHQL,
							VariablesSchema: operationVariablesToJSONSchema(
								parsedGraphQLSchema,
								node,
								[],
								options.keepFromClaimVariables,
								false,
								options.customJsonScalars || []
							),
							InterpolationVariablesSchema: operationVariablesToJSONSchema(
								parsedGraphQLSchema,
								node,
								options.interpolateVariableDefinitionAsJSON || [],
								options.keepFromClaimVariables,
								false,
								options.customJsonScalars || []
							),
							InternalVariablesSchema: operationVariablesToJSONSchema(
								parsedGraphQLSchema,
								node,
								[],
								true,
								false,
								options.customJsonScalars || []
							),
							InjectedVariablesSchema: operationVariablesToJSONSchema(
								parsedGraphQLSchema,
								node,
								[],
								true,
								true,
								options.customJsonScalars || []
							),
							ResponseSchema: operationResponseToJSONSchema(parsedGraphQLSchema, ast, node, transformations),
							AuthenticationConfig: {
								required: false,
							},
							AuthorizationConfig: {
								claims: [],
								roleConfig: {
									requireMatchAll: [],
									requireMatchAny: [],
									denyMatchAll: [],
									denyMatchAny: [],
								},
							},
							HooksConfiguration: {
								preResolve: false,
								postResolve: false,
								mutatingPreResolve: false,
								mutatingPostResolve: false,
								mockResolve: {
									enable: false,
									subscriptionPollingIntervalMillis: 0,
								},
								httpTransportOnResponse: false,
								httpTransportOnRequest: false,
								customResolve: false,
							},
							VariablesConfiguration: {
								injectVariables: [],
							},
							Internal: false,
							PostResolveTransformations: transformations.length > 0 ? transformations : undefined,
						};
						node.variableDefinitions?.forEach((variable) => {
							handleFromClaimDirectives(variable, operation, options.customClaims ?? {});
							handleJsonSchemaDirectives(variable, operation);
							handleUuidDirectives(variable, operation);
							handleDateTimeDirectives(variable, operation);
							handleInjectEnvironmentVariableDirectives(variable, operation);
						});
						operation.Internal = node.directives?.find((d) => d.name.value === 'internalOperation') !== undefined;
						if (wgRoleEnum && wgRoleEnum.kind === 'EnumTypeDefinition') {
							const rbac = node.directives?.find((d) => d.name.value === 'rbac');
							rbac?.arguments?.forEach((arg) => {
								if (arg.value.kind !== 'ListValue') {
									return;
								}
								const values = arg.value.values
									.map((v) => {
										if (v.kind !== 'EnumValue') {
											return '';
										}
										return v.value;
									})
									.filter((v) => wgRoleEnum.values?.find((n) => n.name.value === v) !== undefined);
								switch (arg.name.value) {
									case 'requireMatchAll':
										operation.AuthorizationConfig.roleConfig.requireMatchAll = [
											...new Set([...operation.AuthorizationConfig.roleConfig.requireMatchAll, ...values]),
										];
										return;
									case 'requireMatchAny':
										operation.AuthorizationConfig.roleConfig.requireMatchAny = [
											...new Set([...operation.AuthorizationConfig.roleConfig.requireMatchAny, ...values]),
										];
										return;
									case 'denyMatchAll':
										operation.AuthorizationConfig.roleConfig.denyMatchAll = [
											...new Set([...operation.AuthorizationConfig.roleConfig.denyMatchAll, ...values]),
										];
										return;
									case 'denyMatchAny':
										operation.AuthorizationConfig.roleConfig.denyMatchAny = [
											...new Set([...operation.AuthorizationConfig.roleConfig.denyMatchAny, ...values]),
										];
										return;
								}
							});
						}
						if (
							operation.AuthorizationConfig.roleConfig.denyMatchAny.length +
								operation.AuthorizationConfig.roleConfig.denyMatchAll.length +
								operation.AuthorizationConfig.roleConfig.requireMatchAll.length +
								operation.AuthorizationConfig.roleConfig.requireMatchAny.length !==
							0
						) {
							operation.AuthenticationConfig.required = true;
						}
						if (operation.AuthorizationConfig.claims.length !== 0) {
							operation.AuthenticationConfig.required = true;
						}
						parsed.operations.push(operation);
					},
				},
			});
		} catch (e) {
			Logger.error(e);
			Logger.error(`Operations document: ${operationFile.content}`);
			Logger.error('No Operations found! Please create at least one Operation in the directory ./operations');
			Logger.error("Operation files must have the file extension '.graphql', otherwise they are ignored.");
			Logger.error("Operations don't need to be named, the file name is responsible for the operation name.");
		}
	});
	return parsed;
};

const handleJsonSchemaDirectives = (variable: VariableDefinitionNode, operation: GraphQLOperation) => {
	const directiveName = 'jsonSchema';
	const variableName = variable.variable.name.value;
	const updateJSONSchema = (schema: any, variablePathComponents: string[], update: (schema: JSONSchema) => void) => {
		let properties = schema.properties;
		for (const component of variablePathComponents) {
			if (properties && typeof properties !== 'boolean') {
				properties = properties[component];
			}
		}
		if (properties !== undefined || typeof schema !== 'boolean') {
			update(properties as JSONSchema);
		}
	};
	const updateSchema = (directive: ConstDirectiveNode, update: (schema: JSONSchema) => void) => {
		const variablePathComponents = directiveInjectedVariablePathComponents(directive, variable, operation);
		updateJSONSchema(operation.VariablesSchema, variablePathComponents, update);
		updateJSONSchema(operation.InterpolationVariablesSchema, variablePathComponents, update);
		updateJSONSchema(operation.InternalVariablesSchema, variablePathComponents, update);
		updateJSONSchema(operation.InjectedVariablesSchema, variablePathComponents, update);
	};
	directivesNamed(variable, directiveName).forEach((directive) => {
		directive.arguments?.forEach((arg) => {
			switch (arg.name.value) {
				case 'title':
					updateSchema(directive, (schema) => {
						if (arg.value.kind === 'StringValue') {
							schema.title = arg.value.value;
						}
					});
					return;
				case 'description':
					updateSchema(directive, (schema) => {
						if (arg.value.kind === 'StringValue') {
							schema.description = arg.value.value;
						}
					});
					return;
				case 'multipleOf':
					updateSchema(directive, (schema) => {
						if (arg.value.kind === 'IntValue') {
							schema.multipleOf = parseInt(arg.value.value, 10);
						}
					});
					return;
				case 'maximum':
					updateSchema(directive, (schema) => {
						if (arg.value.kind === 'IntValue') {
							schema.maximum = parseInt(arg.value.value, 10);
						}
					});
					return;
				case 'exclusiveMaximum':
					updateSchema(directive, (schema) => {
						if (arg.value.kind === 'IntValue') {
							schema.exclusiveMaximum = parseInt(arg.value.value, 10);
						}
					});
					return;
				case 'minimum':
					updateSchema(directive, (schema) => {
						if (arg.value.kind === 'IntValue') {
							schema.minimum = parseInt(arg.value.value, 10);
						}
					});
					return;
				case 'exclusiveMinimum':
					updateSchema(directive, (schema) => {
						if (arg.value.kind === 'IntValue') {
							schema.exclusiveMinimum = parseInt(arg.value.value, 10);
						}
					});
					return;
				case 'maxLength':
					updateSchema(directive, (schema) => {
						if (arg.value.kind === 'IntValue') {
							schema.maxLength = parseInt(arg.value.value, 10);
						}
					});
					return;
				case 'minLength':
					updateSchema(directive, (schema) => {
						if (arg.value.kind === 'IntValue') {
							schema.minLength = parseInt(arg.value.value, 10);
						}
					});
					return;
				case 'pattern':
					updateSchema(directive, (schema) => {
						if (arg.value.kind === 'StringValue') {
							schema.pattern = arg.value.value;
						}
					});
					return;
				case 'maxItems':
					updateSchema(directive, (schema) => {
						if (arg.value.kind === 'IntValue') {
							schema.maxItems = parseInt(arg.value.value, 10);
						}
					});
					return;
				case 'minItems':
					updateSchema(directive, (schema) => {
						if (arg.value.kind === 'IntValue') {
							schema.minItems = parseInt(arg.value.value, 10);
						}
					});
					return;
				case 'uniqueItems':
					updateSchema(directive, (schema) => {
						if (arg.value.kind === 'BooleanValue') {
							schema.uniqueItems = arg.value.value;
						}
					});
					return;
				case 'commonPattern':
					updateSchema(directive, (schema) => {
						if (arg.value.kind === 'EnumValue') {
							switch (arg.value.value) {
								case 'EMAIL':
									schema.pattern =
										'(?:[a-z0-9!#$%&\'*+/=?^_`{|}~-]+(?:\\.[a-z0-9!#$%&\'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\\[(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\\])';
									return;
								case 'DOMAIN':
									schema.pattern = '^([a-z0-9]+(-[a-z0-9]+)*\\.)+[a-z]{2,}$';
									return;
								case 'URL':
									schema.pattern =
										'/(((http|ftp|https):\\/{2})+(([0-9a-z_-]+\\.)+(aero|asia|biz|cat|com|coop|edu|gov|info|int|jobs|mil|mobi|museum|name|net|org|pro|tel|travel|ac|ad|ae|af|ag|ai|al|am|an|ao|aq|ar|as|at|au|aw|ax|az|ba|bb|bd|be|bf|bg|bh|bi|bj|bm|bn|bo|br|bs|bt|bv|bw|by|bz|ca|cc|cd|cf|cg|ch|ci|ck|cl|cm|cn|co|cr|cu|cv|cx|cy|cz|cz|de|dj|dk|dm|do|dz|ec|ee|eg|er|es|et|eu|fi|fj|fk|fm|fo|fr|ga|gb|gd|ge|gf|gg|gh|gi|gl|gm|gn|gp|gq|gr|gs|gt|gu|gw|gy|hk|hm|hn|hr|ht|hu|id|ie|il|im|in|io|iq|ir|is|it|je|jm|jo|jp|ke|kg|kh|ki|km|kn|kp|kr|kw|ky|kz|la|lb|lc|li|lk|lr|ls|lt|lu|lv|ly|ma|mc|md|me|mg|mh|mk|ml|mn|mn|mo|mp|mr|ms|mt|mu|mv|mw|mx|my|mz|na|nc|ne|nf|ng|ni|nl|no|np|nr|nu|nz|nom|pa|pe|pf|pg|ph|pk|pl|pm|pn|pr|ps|pt|pw|py|qa|re|ra|rs|ru|rw|sa|sb|sc|sd|se|sg|sh|si|sj|sj|sk|sl|sm|sn|so|sr|st|su|sv|sy|sz|tc|td|tf|tg|th|tj|tk|tl|tm|tn|to|tp|tr|tt|tv|tw|tz|ua|ug|uk|us|uy|uz|va|vc|ve|vg|vi|vn|vu|wf|ws|ye|yt|yu|za|zm|zw|arpa)(:[0-9]+)?((\\/([~0-9a-zA-Z\\#\\+\\%@\\.\\/_-]+))?(\\?[0-9a-zA-Z\\+\\%@\\/&\\[\\];=_-]+)?)?))\\b/imuS\n';
									return;
							}
						}
					});
					return;
			}
		});
	});
};

const parseWellKnownClaim = (name: string, operation?: GraphQLOperation) => {
	const claims: Record<string, ClaimType> = {
		ISSUER: ClaimType.ISSUER,
		PROVIDER: ClaimType.PROVIDER,
		SUBJECT: ClaimType.SUBJECT,
		USERID: ClaimType.USERID,
		NAME: ClaimType.NAME,
		GIVEN_NAME: ClaimType.GIVEN_NAME,
		FAMILY_NAME: ClaimType.FAMILY_NAME,
		MIDDLE_NAME: ClaimType.MIDDLE_NAME,
		NICKNAME: ClaimType.NICKNAME,
		PREFERRED_USERNAME: ClaimType.PREFERRED_USERNAME,
		PROFILE: ClaimType.PROFILE,
		PICTURE: ClaimType.PICTURE,
		WEBSITE: ClaimType.WEBSITE,
		EMAIL: ClaimType.EMAIL,
		EMAIL_VERIFIED: ClaimType.EMAIL_VERIFIED,
		GENDER: ClaimType.GENDER,
		BIRTH_DATE: ClaimType.BIRTH_DATE,
		ZONE_INFO: ClaimType.ZONE_INFO,
		LOCALE: ClaimType.LOCALE,
		LOCATION: ClaimType.LOCATION,
	};
	if (name in claims) {
		return claims[name];
	}
	if (operation) {
		throw new Error(`unhandled claim ${name} on operation ${operation.Name}`);
	}
	throw new Error(`unhandled claim ${name}`);
};

const directiveInjectedVariablePathComponents = (
	directive: ConstDirectiveNode,
	variable: VariableDefinitionNode,
	operation: GraphQLOperation
): string[] => {
	const onArg = directive.arguments?.find((arg) => arg.name.value === 'on');
	const variableName = variable.variable.name.value;
	let variablePathComponents: string[];
	if (onArg) {
		if (onArg.value.kind !== Kind.STRING) {
			throw new Error(
				`@${directive.name.value} on: argument on operation ${operation.Name} (${variableName}) must be a String, not ${onArg.value.kind}`
			);
		}
		variablePathComponents = [variableName, ...onArg.value.value.split('.')];
	} else {
		variablePathComponents = [variableName];
	}
	return variablePathComponents;
};

const handleFromClaimDirective = (
	fromClaimDirective: ConstDirectiveNode,
	variable: VariableDefinitionNode,
	operation: GraphQLOperation,
	customClaims: Record<string, CustomClaim>
) => {
	if (fromClaimDirective.arguments === undefined) {
		throw new Error(`@fromClaim directive on operation ${operation.Name} has no arguments`);
	}
	const nameArg = fromClaimDirective.arguments.find((arg) => arg.name.value === 'name');
	if (nameArg === undefined) {
		throw new Error(`@fromClaim on operation ${operation.Name} does not have a name: argument`);
	}
	if (nameArg.value.kind !== Kind.ENUM) {
		throw new Error(
			`@fromClaim name: argument on operation ${operation.Name} must be a WG_CLAIM, not ${nameArg.value.kind}`
		);
	}
	let variablePathComponents = directiveInjectedVariablePathComponents(fromClaimDirective, variable, operation);
	const claimName = nameArg.value.value;
	let claim: ClaimConfig;
	if (claimName in customClaims) {
		const customClaim = customClaims[claimName];
		claim = {
			variablePathComponents,
			claimType: ClaimType.CUSTOM,
			custom: {
				name: claimName,
				jsonPathComponents: customClaim.jsonPathComponents,
				type: customClaim.type,
				required: customClaim.required,
			},
		};
	} else {
		claim = {
			variablePathComponents,
			claimType: parseWellKnownClaim(claimName),
		};
	}
	operation.AuthenticationConfig.required = true;
	operation.AuthorizationConfig.claims.push(claim);
};

const handleFromClaimDirectives = (
	variable: VariableDefinitionNode,
	operation: GraphQLOperation,
	customClaims: Record<string, CustomClaim>
) => {
	directivesNamed(variable, 'fromClaim').forEach((directive) => {
		handleFromClaimDirective(directive, variable, operation, customClaims);
	});
};

const handleInjectEnvironmentVariableDirectives = (variable: VariableDefinitionNode, operation: GraphQLOperation) => {
	const directiveName = 'injectEnvironmentVariable';
	directivesNamed(variable, directiveName).forEach((directive) => {
		const arg = directive.arguments?.find((arg) => arg.name.value === 'name');
		if (!arg) {
			throw new Error(`name: argument missing in @${directiveName} in operation ${operation.Name}`);
		}
		if (arg.value.kind !== Kind.STRING) {
			throw new Error(
				`name: argument in @${directiveName} in operation ${operation.Name} must be string, not ${arg.value.kind}`
			);
		}
		let variablePathComponents = directiveInjectedVariablePathComponents(directive, variable, operation);
		operation.VariablesConfiguration.injectVariables.push({
			...defaultVariableInjectionConfiguration,
			variablePathComponents,
			variableKind: InjectVariableKind.ENVIRONMENT_VARIABLE,
			environmentVariableName: arg.value.value,
		});
	});
};

const handleUuidDirectives = (variable: VariableDefinitionNode, operation: GraphQLOperation) => {
	directivesNamed(variable, 'injectGeneratedUUID').forEach((directive) => {
		let variablePathComponents = directiveInjectedVariablePathComponents(directive, variable, operation);
		operation.VariablesConfiguration.injectVariables.push({
			...defaultVariableInjectionConfiguration,
			variablePathComponents,
			variableKind: InjectVariableKind.UUID,
		});
	});
};

const getTimeFormat = (timeFormat: string): string => {
	const availableTimeFormats: Record<string, string> = {
		ISO8601: '2006-01-02T15:04:05Z07:00',
		ANSIC: 'Mon Jan _2 15:04:05 2006',
		UnixDate: 'Mon Jan _2 15:04:05 MST 2006',
		RubyDate: 'Mon Jan 02 15:04:05 -0700 2006',
		RFC822: '02 Jan 06 15:04 MST',
		RFC822Z: '02 Jan 06 15:04 -0700',
		RFC850: 'Monday, 02-Jan-06 15:04:05 MST',
		RFC1123: 'Mon, 02 Jan 2006 15:04:05 MST',
		RFC1123Z: 'Mon, 02 Jan 2006 15:04:05 -0700',
		RFC3339: '2006-01-02T15:04:05Z07:00',
		RFC3339Nano: '2006-01-02T15:04:05.999999999Z07:00',
		Kitchen: '3:04PM',
		Stamp: 'Jan _2 15:04:05',
		StampMilli: 'Jan _2 15:04:05.000',
		StampMicro: 'Jan _2 15:04:05.000000',
		StampNano: 'Jan _2 15:04:05.000000000',
	};

	if (timeFormat in availableTimeFormats) {
		return availableTimeFormats[timeFormat];
	}
	throw new Error(`unknown time format "${timeFormat}`);
};

const handleDateTimeDirectives = (variable: VariableDefinitionNode, operation: GraphQLOperation) => {
	const directiveName = 'injectCurrentDateTime';
	directivesNamed(variable, directiveName).forEach((directive) => {
		const formatArg = directive.arguments?.find((arg) => arg.name.value === 'format');
		const customFormatArg = directive.arguments?.find((arg) => arg.name.value === 'customFormat');
		if (formatArg && customFormatArg) {
			throw new Error(`@${directiveName} in operation ${operation.Name} has both format: and customFormat: arguments`);
		}
		let dateFormat: string;
		if (formatArg) {
			if (formatArg.value.kind !== Kind.ENUM) {
				throw new Error(
					`format: argument in @${directiveName} in operation ${operation.Name} must be an enum, not ${formatArg.value.kind}`
				);
			}
			dateFormat = getTimeFormat(formatArg.value.value);
		} else if (customFormatArg) {
			if (customFormatArg.value.kind != Kind.STRING) {
				throw new Error(
					`customFormat: argument in @${directiveName} in operation ${operation.Name} must be a String, not ${customFormatArg.value.kind}`
				);
			}
			dateFormat = customFormatArg.value.value;
		} else {
			// Default format
			dateFormat = '2006-01-02T15:04:05Z07:00';
		}
		let variablePathComponents = directiveInjectedVariablePathComponents(directive, variable, operation);
		operation.VariablesConfiguration.injectVariables.push({
			...defaultVariableInjectionConfiguration,
			variablePathComponents,
			dateFormat: '2006-01-02T15:04:05Z07:00',
			variableKind: InjectVariableKind.DATE_TIME,
		});
	});
};

const parseOperationTypeNode = (node: OperationTypeNode): OperationType => {
	switch (node) {
		case 'subscription':
			return OperationType.SUBSCRIPTION;
		case 'mutation':
			return OperationType.MUTATION;
		case 'query':
			return OperationType.QUERY;
		default:
			return -1;
	}
};

const updateSkipFields = (skipFields: SchemaSkipFields, skipVariablePaths: string[]): SchemaSkipFields => {
	skipVariablePaths.forEach((field) => {
		let fields = skipFields;
		for (let component of field?.split('.')) {
			if (fields[component] === undefined) {
				fields[component] = {};
			}
			fields = fields[component];
		}
	});
	return skipFields;
};

export const operationVariablesToJSONSchema = (
	graphQLSchema: GraphQLSchema,
	operation: OperationDefinitionNode,
	interpolateVariableDefinitionAsJSON: string[],
	keepInternalVariables: boolean = false,
	keepInjectedVariables: boolean = false,
	customJsonScalars: string[]
): JSONSchema => {
	const schema: JSONSchema = {
		type: 'object',
		properties: {},
		additionalProperties: false,
		definitions: {},
	};

	if (!operation.variableDefinitions) {
		return schema;
	}

	operation.variableDefinitions.forEach((variable) => {
		let skipFields: SchemaSkipFields = {};
		if (!keepInternalVariables) {
			if (hasInternalVariable(variable)) {
				return;
			}
			updateSkipFields(skipFields, directiveDefinedFields(variable, internalVariables));
		}
		if (!keepInjectedVariables) {
			if (hasInjectedVariable(variable)) {
				return;
			}
			updateSkipFields(skipFields, directiveDefinedFields(variable, injectedVariables));
		}
		let type = variable.type;
		let nonNullType = false;
		if (type.kind === 'NonNullType' && variable.defaultValue !== undefined) {
			type = type.type;
			nonNullType = true;
		}
		const name = variable.variable.name.value;
		schema.properties![name] = typeSchema(
			schema,
			schema,
			graphQLSchema,
			interpolateVariableDefinitionAsJSON,
			type,
			name,
			nonNullType,
			customJsonScalars,
			skipFields
		);
	});

	return schema;
};

const internalVariables = [
	'fromClaim',
	'internal',
	'injectGeneratedUUID',
	'injectCurrentDateTime',
	'injectEnvironmentVariable',
];

const injectedVariables = ['injectGeneratedUUID', 'injectCurrentDateTime', 'injectEnvironmentVariable'];

const directivesNamed = (variable: VariableDefinitionNode, directiveNames: string | string[]): ConstDirectiveNode[] => {
	const isDefined = (node: ConstDirectiveNode | undefined): node is ConstDirectiveNode => {
		return !!node;
	};
	if (!Array.isArray(directiveNames)) {
		directiveNames = [directiveNames];
	}
	return (
		variable.directives?.filter((directive) => directiveNames.includes(directive.name.value)).filter(isDefined) ?? []
	);
};

const directiveHasNoField = (node: ConstDirectiveNode) => {
	return !directiveInjectedField(node);
};

const directiveInjectedField = (node: ConstDirectiveNode) => {
	const onArgument = node.arguments?.find((arg) => arg.name.value === 'on');
	if (!onArgument) {
		return undefined;
	}
	if (onArgument.value.kind !== Kind.STRING) {
		return undefined;
	}
	return onArgument.value.value;
};

const hasInternalVariable = (variable: VariableDefinitionNode): boolean => {
	return (directivesNamed(variable, internalVariables)?.filter(directiveHasNoField)?.length ?? 0) > 0;
};

const hasInjectedVariable = (variable: VariableDefinitionNode): boolean => {
	return (directivesNamed(variable, injectedVariables)?.filter(directiveHasNoField)?.length ?? 0) > 0;
};

const directiveDefinedFields = (variable: VariableDefinitionNode, directiveNames: string[]) => {
	const isString = (field: string | undefined): field is string => {
		return !!field;
	};
	return (
		directivesNamed(variable, directiveNames)
			?.map((directive) => directiveInjectedField(directive))
			.filter(isString) ?? []
	);
};

// Leafs are fields that should be skipped from schema generation
interface SchemaSkipFields {
	[key: string]: SchemaSkipFields;
}

const typeSchema = (
	root: JSONSchema,
	parent: JSONSchema,
	graphQLSchema: GraphQLSchema,
	interpolateVariableDefinitionAsJSON: string[],
	type: TypeNode,
	name: string,
	nonNull: boolean,
	customJsonScalars: string[],
	skipFields?: SchemaSkipFields
): JSONSchema => {
	switch (type.kind) {
		case 'NonNullType':
			switch (parent.type) {
				case 'object':
					parent.required = [...(parent.required || []), name];
					break;
				case 'array':
					parent.minItems = 1;
					break;
			}
			return typeSchema(
				root,
				parent,
				graphQLSchema,
				interpolateVariableDefinitionAsJSON,
				type.type,
				name,
				true,
				customJsonScalars,
				skipFields
			);
		case 'ListType':
			const schema: JSONSchema = {
				type: nonNull ? 'array' : ['array', 'null'],
			};
			schema.items = typeSchema(
				root,
				schema,
				graphQLSchema,
				interpolateVariableDefinitionAsJSON,
				type.type,
				name,
				false,
				customJsonScalars,
				skipFields
			);
			return schema;
		case 'NamedType':
			switch (type.name.value) {
				case 'Int':
					return {
						type: nonNull ? 'integer' : ['integer', 'null'],
					};
				case 'Boolean':
					return {
						type: nonNull ? 'boolean' : ['boolean', 'null'],
					};
				case 'ID':
					return {
						type: nonNull ? 'string' : ['string', 'null'],
					};
				case 'Float':
					return {
						type: nonNull ? 'number' : ['number', 'null'],
					};
				case 'String':
					return {
						type: nonNull ? 'string' : ['string', 'null'],
					};
				case 'JSON':
					return {};
				default:
					if (customJsonScalars.includes(type.name.value)) {
						return {};
					}

					let schema: JSONSchema = {};
					const namedType = graphQLSchema.getType(type.name.value);
					if (namedType === null || namedType === undefined || !namedType.astNode) {
						return {};
					}
					if (interpolateVariableDefinitionAsJSON.length) {
						if (interpolateVariableDefinitionAsJSON.includes(namedType.name)) {
							return {}; // return empty JSON Schema (treated as JSON:any)
						}
					}
					switch (namedType.astNode.kind) {
						case 'ScalarTypeDefinition':
							return {
								type: nonNull ? 'string' : ['string', 'null'],
							};
						case 'EnumTypeDefinition':
							schema.type = nonNull ? 'string' : ['string', 'null'];
							schema.enum = (namedType.astNode.values || []).map((e) => {
								return e.name.value;
							});
							break;
						case 'InputObjectTypeDefinition':
							const typeName = namedType.name;
							if (Object.keys(root.definitions!).includes(typeName)) {
								return {
									$ref: '#/definitions/' + typeName,
								};
							}
							root.definitions![typeName] = {
								type: nonNull ? 'object' : ['object', 'null'],
							};
							schema.additionalProperties = false;
							schema.type = nonNull ? 'object' : ['object', 'null'];
							schema.properties = {};
							(namedType.astNode.fields || []).forEach((f) => {
								const name = f.name.value;
								let currentSkipFields = skipFields ? skipFields[name] : undefined;
								if (currentSkipFields !== undefined && Object.keys(currentSkipFields).length == 0) {
									// Leaf
									return;
								}
								let fieldType = f.type;
								if (f.defaultValue !== undefined && fieldType.kind === 'NonNullType') {
									fieldType = fieldType.type;
								}
								schema.properties![name] = typeSchema(
									root,
									schema,
									graphQLSchema,
									interpolateVariableDefinitionAsJSON,
									fieldType,
									name,
									false,
									customJsonScalars,
									currentSkipFields
								);
							});
							root.definitions![typeName] = schema;
							return {
								$ref: '#/definitions/' + typeName,
							};
					}
					return schema;
			}
	}
	return {};
};

export const operationResponseToJSONSchema = (
	graphQLSchema: GraphQLSchema,
	operationDocument: DocumentNode,
	operationNode: OperationDefinitionNode,
	transformations: PostResolveTransformation[]
): JSONSchema => {
	const dataSchema: JSONSchema = {
		type: 'object',
		properties: {},
		additionalProperties: false,
	};
	const schema: JSONSchema = {
		type: 'object',
		properties: {
			data: dataSchema,
		},
		additionalProperties: false,
	};
	const typeName = operationRootTypeName(operationNode, graphQLSchema);
	resolveSelections(
		graphQLSchema,
		operationDocument,
		operationNode.selectionSet.selections,
		typeName,
		dataSchema,
		['data'],
		transformations
	);
	return schema;
};

const operationRootTypeName = (node: OperationDefinitionNode, graphQLSchema: GraphQLSchema): string => {
	switch (node.operation) {
		case 'query':
			return (graphQLSchema.getQueryType() || {}).name || '';
		case 'mutation':
			return (graphQLSchema.getMutationType() || {}).name || '';
		case 'subscription':
			return (graphQLSchema.getSubscriptionType() || {}).name || '';
		default:
			return '';
	}
};

const resolveSelections = (
	graphQLSchema: GraphQLSchema,
	operationDocument: DocumentNode,
	selections: ReadonlyArray<SelectionNode>,
	parentTypeName: string,
	parentObject: JSONSchema,
	documentPath: string[],
	transformations: PostResolveTransformation[]
) => {
	const parentType = graphQLSchema.getType(parentTypeName);
	if (!parentType || !parentType.astNode) {
		return;
	}
	if (parentType.astNode.kind === 'UnionTypeDefinition') {
		selections.forEach((selection) => {
			switch (selection.kind) {
				case 'Field':
					const fieldName = selection.name.value;
					const propName = selection.alias !== undefined ? selection.alias.value : selection.name.value;
					if (fieldName !== '__typename') {
						return;
					}
					parentObject.properties![propName] = {
						type: 'string',
						enum: ((parentType!.astNode as UnionTypeDefinitionNode).types || []).map((t) => t.name.value),
					};
					if (parentObject.required) {
						parentObject.required.push(propName);
					} else {
						parentObject.required = [propName];
					}
					return;
				case 'InlineFragment':
					if (!selection.typeCondition) {
						return;
					}
					const typeName = selection.typeCondition.name.value;
					resolveSelections(
						graphQLSchema,
						operationDocument,
						selection.selectionSet.selections,
						typeName,
						parentObject,
						documentPath,
						transformations
					);
					delete parentObject.required; // union root fields are always optional
					return;
				case 'FragmentSpread':
					const fragmentDefinition = operationDocument.definitions.find(
						(node) => node.kind === 'FragmentDefinition' && node.name.value === selection.name.value
					);
					if (fragmentDefinition) {
						const typeName = (fragmentDefinition as FragmentDefinitionNode).typeCondition.name.value;
						const selections = (fragmentDefinition as FragmentDefinitionNode).selectionSet.selections;
						resolveSelections(
							graphQLSchema,
							operationDocument,
							selections,
							typeName,
							parentObject,
							documentPath,
							transformations
						);
						delete parentObject.required; // union root fields are always optional
						return;
					}
			}
		});
		return;
	}
	if (
		(parentType.astNode.kind !== 'ObjectTypeDefinition' && parentType.astNode.kind !== 'InterfaceTypeDefinition') ||
		!parentType.astNode.fields
	) {
		return;
	}
	selections.forEach((selection) => {
		switch (selection.kind) {
			case 'Field':
				const fieldName = selection.name.value;
				const propName = selection.alias !== undefined ? selection.alias.value : selection.name.value;
				if (fieldName === '__typename') {
					if (
						parentObject.properties![propName] !== undefined &&
						(parentObject.properties![propName] as JSONSchema).enum !== undefined
					) {
						(parentObject.properties![propName] as JSONSchema).enum!.push(parentTypeName);
					} else {
						parentObject.properties![propName] = {
							type: 'string',
							enum: [parentTypeName],
						};
						if (parentObject.required) {
							parentObject.required.push(propName);
						} else {
							parentObject.required = [propName];
						}
					}
					return;
				}
				const definition = (parentType.astNode as ObjectTypeDefinitionNode).fields!.find(
					(f) => f.name.value === fieldName
				);
				if (!definition) {
					return;
				}

				let schema = resolveFieldSchema(
					graphQLSchema,
					operationDocument,
					propName,
					selection,
					definition.type,
					parentObject,
					[...documentPath, propName],
					transformations
				);

				const transformDirective = selection.directives?.find((d) => d.name.value === 'transform');
				if (transformDirective) {
					schema = handleTransformDirective(transformDirective, schema, [...documentPath, propName], transformations);
				}

				parentObject.properties![propName] = schema;
				break;
			case 'FragmentSpread':
				const fragmentDefinition = operationDocument.definitions.find(
					(node) => node.kind === 'FragmentDefinition' && node.name.value === selection.name.value
				) as FragmentDefinitionNode;
				resolveSelections(
					graphQLSchema,
					operationDocument,
					fragmentDefinition.selectionSet.selections,
					parentTypeName,
					parentObject,
					documentPath,
					transformations
				);
				break;
			case 'InlineFragment':
				resolveSelections(
					graphQLSchema,
					operationDocument,
					selection.selectionSet.selections,
					parentTypeName,
					parentObject,
					documentPath,
					transformations
				);
				break;
		}
	});
};

const resolveFieldSchema = (
	graphQLSchema: GraphQLSchema,
	operationDocument: DocumentNode,
	propName: string,
	field: FieldNode,
	fieldType: TypeNode,
	parent: JSONSchema,
	documentPath: string[],
	transformations: PostResolveTransformation[]
): JSONSchema => {
	switch (fieldType.kind) {
		case 'NonNullType':
			switch (parent.type) {
				case 'object':
					parent.required = [...new Set([...(parent.required || []), propName])];
					return resolveFieldSchema(
						graphQLSchema,
						operationDocument,
						propName,
						field,
						fieldType.type,
						parent,
						documentPath,
						transformations
					);
				case 'array':
					parent.minItems = 1;
					return resolveFieldSchema(
						graphQLSchema,
						operationDocument,
						propName,
						field,
						fieldType.type,
						parent,
						documentPath,
						transformations
					);
				default:
					return {};
			}
		case 'ListType':
			return {
				type: 'array',
				items: resolveFieldSchema(
					graphQLSchema,
					operationDocument,
					propName,
					field,
					fieldType.type,
					parent,
					[...documentPath, '[]'],
					transformations
				),
			};
		case 'NamedType':
			switch (fieldType.name.value) {
				case 'Int':
					return {
						type: 'integer',
					};
				case 'Boolean':
					return {
						type: 'boolean',
					};
				case 'ID':
					return {
						type: 'string',
					};
				case 'Float':
					return {
						type: 'number',
					};
				case 'String':
					return {
						type: 'string',
					};
				case 'JSON':
					return {};
				default:
					let schema: JSONSchema = {};
					const namedType = graphQLSchema.getType(fieldType.name.value);
					if (namedType === null || namedType === undefined || !namedType.astNode) {
						return {};
					}
					switch (namedType.astNode.kind) {
						case 'ScalarTypeDefinition':
							return {
								type: 'string',
							};
						case 'EnumTypeDefinition':
							schema.type = 'string';
							schema.enum = (namedType.astNode.values || []).map((e) => {
								return e.name.value;
							});
							break;
						case 'UnionTypeDefinition':
						case 'InterfaceTypeDefinition':
						case 'ObjectTypeDefinition':
							schema.type = 'object';
							schema.properties = {};
							schema.additionalProperties = false;
							if (!field.selectionSet) {
								return schema;
							}
							resolveSelections(
								graphQLSchema,
								operationDocument,
								field.selectionSet.selections,
								namedType.name,
								schema,
								documentPath,
								transformations
							);
							break;
					}
					return schema;
			}
	}
	return {};
};

const handleTransformDirective = (
	transformDirective: DirectiveNode,
	schema: JSONSchema,
	documentPath: string[],
	transformations: PostResolveTransformation[]
): JSONSchema => {
	const get = transformDirective.arguments?.find((arg) => arg.name.value === 'get');
	if (get && get.value.kind === 'StringValue') {
		const path = get.value.value.split('.');
		const outPath: string[] = [];
		let updatedSchema = Object.assign({}, schema);
		let valid = true;
		path.forEach((elem) => {
			if (elem === '[]' && updatedSchema.items) {
				outPath.push('[]');
				// @ts-ignore
				updatedSchema = updatedSchema.items;
				return;
			}
			if (updatedSchema.items) {
				// unwrap array so that we can get to the property
				outPath.push('[]');
				// @ts-ignore
				updatedSchema = updatedSchema.items;
			}
			if (updatedSchema.properties) {
				outPath.push(elem);
				// @ts-ignore
				updatedSchema = updatedSchema.properties[elem];
				return;
			}
			valid = false;
		});
		if (valid) {
			const from = [...documentPath, ...outPath];
			transformations.push({
				kind: 'get',
				depth: from.length,
				get: {
					from: from,
					to: documentPath,
				},
			});
			return updatedSchema;
		} else {
			throw new Error(`Invalid path for get transformation: ${get.value.value}, schema: ${JSON.stringify(schema)}`);
		}
	}
	return schema;
};

export interface LoadOperationsOutput {
	graphql_operation_files?: GraphQLOperationFile[];
	typescript_operation_files?: TypeScriptOperationFile[];
	invalid?: string[];
	errors?: string[];
	info?: string[];
}

export interface GraphQLOperationFile {
	operation_name: string;
	api_mount_path: string;
	file_path: string;
	content: string;
}

export interface TypeScriptOperationFile {
	operation_name: string;
	api_mount_path: string;
	file_path: string;
	module_path: string;
}

export const loadOperations = (schemaFileName: string): LoadOperationsOutput => {
	const operationsPath = path.join(process.env.WG_DIR_ABS!, 'operations');
	const fragmentsPath = path.join(process.env.WG_DIR_ABS!, 'fragments');
	const schemaFilePath = path.join(process.env.WG_DIR_ABS!, 'generated', schemaFileName);
	const outFilePath = path.join(process.env.WG_DIR_ABS!, 'generated', 'wundergraph.operations.json');
	const result = wunderctlExec({
		cmd: ['loadoperations', operationsPath, fragmentsPath, schemaFilePath, '--pretty'],
	});
	if (result?.failed) {
		throw new Error(result?.stderr);
	}

	const output = fs.readFileSync(outFilePath, 'utf8');
	const out = JSON.parse(output) as LoadOperationsOutput;

	out.info?.forEach((msg) => Logger.info(msg));
	out.errors?.forEach((msg) => Logger.error(msg));

	if (WG_THROW_ON_OPERATION_LOADING_ERROR && (out.errors?.length ?? 0) > 0 && out?.errors?.[0]) {
		throw new Error(out.errors[0]);
	}

	return out;
};

export const removeHookVariables = (operation: string): string => {
	if (operation === '') {
		return operation;
	}
	const document = parse(operation);
	const updated = visit(document, {
		VariableDefinition: (node) => {
			const isHooksVariable = node.directives?.find((d) => d.name.value === 'hooksVariable') !== undefined;
			if (isHooksVariable) {
				return null;
			}
			return node;
		},
	});
	return print(updated);
};

export const removeTransformDirectives = (operation: string): string => {
	const document = parse(operation);
	const updated = visit(document, {
		Directive: (node) => {
			if (node.name.value === 'transform') {
				return null;
			}
		},
	});
	return print(updated);
};
