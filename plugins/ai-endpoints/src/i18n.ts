/** AI endpoints copy — one typed catalog per locale, resolved from
 * the panel page ctx (same contract as eval-validator's i18n). */
export const AI_ENDPOINT_LOCALES = ["en", "pt-BR", "es"] as const;

export interface AiEndpointMessages {
	readonly endpointsTitle: string;
	readonly endpointsDesc: string;
	readonly newEndpoint: string;
	readonly edit: string;
	readonly confirmDelete: string;
	readonly cancel: string;
	readonly save: string;
	readonly name: string;
	readonly kind: string;
	readonly baseUrl: string;
	readonly model: string;
	readonly sessionId: string;
	readonly secretRef: string;
	readonly secretRefHint: string;
	readonly secretRefNone: string;
	readonly secretRefCustom: string;
	readonly scopeLabel: string;
	readonly isDefaultLabel: string;
	readonly timeoutMs: string;
	readonly enabled: string;
	readonly test: string;
	readonly testOk: string;
	readonly testFailed: string;
	readonly transport: string;
	readonly transportHint: string;
	readonly acpHint: string;
	readonly emptyEndpoints: string;
	readonly actionFailed: string;
}

const en: AiEndpointMessages = {
	endpointsTitle: "Endpoints",
	endpointsDesc:
		"Generative providers any AI surface can bind — secrets resolve through Credentials, never the table.",
	newEndpoint: "New endpoint",
	edit: "Edit",
	confirmDelete: "Confirm delete",
	cancel: "Cancel",
	save: "Save",
	name: "Name",
	kind: "Kind",
	baseUrl: "Base URL",
	model: "Model",
	sessionId: "Session id",
	secretRef: "API key env var",
	secretRefHint: "Name of the env var holding the key — never the key itself.",
	secretRefNone: "None",
	secretRefCustom: "Custom env var",
	scopeLabel: "Scope",
	isDefaultLabel: "Default endpoint",
	timeoutMs: "Timeout (ms)",
	enabled: "Enabled",
	test: "Test",
	testOk: "endpoint ok",
	testFailed: "endpoint failed",
	transport: "Transport",
	transportHint: "child/ssh need the Node runtime — this app only drives ws.",
	acpHint:
		"Connects a local agent over ACP (e.g. Claude Code). No API key needed — run `claude agent acp` and paste the session id.",
	emptyEndpoints: "No endpoints — generation falls back to the template renderer.",
	actionFailed: "Action failed — check permissions and try again.",
};

const ptBR: AiEndpointMessages = {
	...en,
	endpointsTitle: "Endpoints",
	endpointsDesc:
		"Provedores generativos que qualquer superfície de IA pode usar — segredos resolvem via Credenciais, nunca a tabela.",
	newEndpoint: "Novo endpoint",
	edit: "Editar",
	confirmDelete: "Confirmar exclusão",
	cancel: "Cancelar",
	save: "Salvar",
	name: "Nome",
	kind: "Tipo",
	baseUrl: "URL base",
	model: "Modelo",
	sessionId: "Id de sessão",
	secretRef: "Env var da API key",
	secretRefHint: "Nome da env var que guarda a chave — nunca a chave em si.",
	secretRefNone: "Nenhuma",
	secretRefCustom: "Env var personalizada",
	scopeLabel: "Escopo",
	isDefaultLabel: "Endpoint padrão",
	timeoutMs: "Timeout (ms)",
	enabled: "Ativo",
	test: "Testar",
	testOk: "endpoint ok",
	testFailed: "endpoint falhou",
	transport: "Transporte",
	transportHint: "child/ssh precisam do runtime Node — este app só usa ws.",
	acpHint:
		"Conecta um agente local via ACP (ex.: Claude Code). Sem API key — rode `claude agent acp` e cole o id de sessão.",
	emptyEndpoints: "Sem endpoints — a geração usa o renderizador de template.",
	actionFailed: "Ação falhou — verifique permissões e tente de novo.",
};

const es: AiEndpointMessages = {
	...ptBR,
	...en,
	endpointsDesc:
		"Proveedores generativos que cualquier superficie de IA puede usar — los secretos se resuelven vía Credenciales, nunca la tabla.",
	newEndpoint: "Nuevo endpoint",
	edit: "Editar",
	confirmDelete: "Confirmar eliminación",
	cancel: "Cancelar",
	save: "Guardar",
	name: "Nombre",
	scopeLabel: "Ámbito",
	isDefaultLabel: "Endpoint predeterminado",
	test: "Probar",
	transport: "Transporte",
	transportHint: "child/ssh necesitan el runtime Node — esta app solo usa ws.",
	acpHint:
		"Conecta un agente local vía ACP (p. ej. Claude Code). Sin API key — ejecuta `claude agent acp` y pega el id de sesión.",
	secretRefNone: "Ninguna",
	secretRefCustom: "Env var personalizada",
	actionFailed: "La acción falló — revisa permisos e intenta de nuevo.",
};

export const aiEndpointMessages = (locale: string): AiEndpointMessages =>
	locale === "pt-BR" ? ptBR : locale === "es" ? es : en;
