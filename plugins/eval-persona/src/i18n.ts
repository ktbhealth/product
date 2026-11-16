/** Eval lab copy — one typed catalog per locale, resolved from the
 * panel page ctx (same contract as eval-validator's i18n). */
export const EVAL_LOCALES = ["en", "pt-BR", "es"] as const;

export interface EvalLabMessages {
	readonly personasTitle: string;
	readonly personasDesc: string;
	readonly instancesTitle: string;
	readonly instancesDesc: string;
	readonly endpointsTitle: string;
	readonly newPersona: string;
	readonly newInstance: string;
	readonly newEndpoint: string;
	readonly edit: string;
	readonly delete: string;
	readonly confirmDelete: string;
	readonly cancel: string;
	readonly save: string;
	readonly create: string;
	readonly name: string;
	readonly patient: string;
	readonly doctor: string;
	readonly axes: string;
	readonly notes: string;
	readonly gender: string;
	readonly ageBand: string;
	readonly socialClass: string;
	readonly education: string;
	readonly region: string;
	readonly register: string;
	readonly specialty: string;
	readonly doctorGender: string;
	readonly doctorRegister: string;
	readonly emptyDefs: string;
	readonly emptyInstances: string;
	readonly emptyEndpoints: string;
	readonly mode: string;
	readonly modeSelected: string;
	readonly modeRandom: string;
	readonly count: string;
	readonly seed: string;
	readonly minutes: string;
	readonly endpoint: string;
	readonly endpointTemplate: string;
	readonly kind: string;
	readonly baseUrl: string;
	readonly model: string;
	readonly sessionId: string;
	readonly secretRef: string;
	readonly secretRefHint: string;
	readonly timeoutMs: string;
	readonly enabled: string;
	readonly start: string;
	readonly test: string;
	readonly testOk: string;
	readonly testFailed: string;
	readonly openDetail: string;
	readonly items: string;
	readonly progress: string;
	readonly distribution: string;
	readonly reviewHint: string;
	readonly actionFailed: string;
	readonly statusDraft: string;
	readonly statusGenerating: string;
	readonly statusReady: string;
	readonly statusFailed: string;
	readonly statusPending: string;
	readonly statusDone: string;
	readonly statusError: string;
	readonly female: string;
	readonly male: string;
	readonly personaPurpose: string;
	readonly patientSection: string;
	readonly doctorSection: string;
	readonly randomize: string;
	readonly generatePersonas: string;
	readonly genHint: string;
	readonly genDone: string;
	readonly spawnGenerators: string;
	readonly spawnHint: string;
	readonly generators: string;
	readonly perGenerator: string;
	readonly transport: string;
	readonly transportHint: string;
	readonly acpHint: string;
	readonly secretRefNone: string;
	readonly secretRefCustom: string;
	readonly axisLabels: Record<string, string>;
}

const en: EvalLabMessages = {
	personasTitle: "Personas",
	personasDesc: "Curated persona definitions — the eval setup each instance can pick.",
	instancesTitle: "Instances",
	instancesDesc: "Generation runs: pick personas or sample randomly, then generate.",
	endpointsTitle: "LLM endpoints",
	newPersona: "New persona",
	newInstance: "New instance",
	newEndpoint: "New endpoint",
	edit: "Edit",
	delete: "Delete",
	confirmDelete: "Confirm delete",
	cancel: "Cancel",
	save: "Save",
	create: "Create",
	name: "Name",
	patient: "Patient",
	doctor: "Doctor",
	axes: "Axes",
	notes: "Notes",
	gender: "Gender",
	ageBand: "Age band",
	socialClass: "Social class",
	education: "Education",
	region: "Region",
	register: "Register",
	specialty: "Specialty",
	doctorGender: "Doctor gender",
	doctorRegister: "Doctor register",
	emptyDefs: "No personas yet — create the eval setup first.",
	emptyInstances: "No instances yet.",
	emptyEndpoints: "No endpoints — generation falls back to the template renderer.",
	mode: "Mode",
	modeSelected: "Selected personas",
	modeRandom: "Random sample",
	count: "Count",
	seed: "Seed",
	minutes: "Interview length (min)",
	endpoint: "Endpoint",
	endpointTemplate: "Template (deterministic, no LLM)",
	kind: "Kind",
	baseUrl: "Base URL",
	model: "Model",
	sessionId: "Session id",
	secretRef: "API key env var",
	secretRefHint: "Name of the env var holding the key — never the key itself.",
	timeoutMs: "Timeout (ms)",
	enabled: "Enabled",
	start: "Generate",
	test: "Test",
	testOk: "endpoint ok",
	testFailed: "endpoint failed",
	openDetail: "Open",
	items: "items",
	progress: "Progress",
	distribution: "Cohort distribution",
	reviewHint: "Generated personas await review in Eval validator.",
	actionFailed: "Action failed — check permissions and try again.",
	statusDraft: "draft",
	statusGenerating: "generating",
	statusReady: "ready",
	statusFailed: "failed",
	statusPending: "pending",
	statusDone: "done",
	statusError: "error",
	female: "female",
	male: "male",
	personaPurpose:
		"A persona is a reusable patient + doctor profile. Instances pick personas to generate synthetic consultations.",
	patientSection: "Patient",
	doctorSection: "Doctor",
	randomize: "Surprise me",
	generatePersonas: "Generate personas",
	genHint:
		"An LLM endpoint drafts the personas; the template option samples the demographic matrix deterministically.",
	genDone: "Personas created — they appear in the list below.",
	spawnGenerators: "Spawn generators",
	spawnHint:
		"Creates N draft instances named “generator #1..N”, each sampling personas on the chosen endpoint.",
	generators: "Generators",
	perGenerator: "Personas per generator",
	transport: "Transport",
	transportHint: "child/ssh need the Node runtime — this app only drives ws.",
	acpHint:
		"Connects a local agent over ACP (e.g. Claude Code). No API key needed — run `claude agent acp` and paste the session id.",
	secretRefNone: "None",
	secretRefCustom: "Custom env var",
	axisLabels: {
		child: "Child (0-12)",
		adult: "Adult (18-64)",
		elderly: "Elderly (65+)",
		low: "Low income",
		middle: "Middle income",
		high: "High income",
		primary: "Primary school",
		secondary: "High school",
		higher: "College+",
		north: "North",
		northeast: "Northeast",
		central: "Center-West",
		southeast: "Southeast",
		south: "South",
		colloquial: "Colloquial — lay terms",
		neutral: "Neutral",
		technical: "Technical — medical terms",
		general_practice: "General practice",
		cardiology: "Cardiology",
		dermatology: "Dermatology",
		pediatrics: "Pediatrics",
	},
};

const ptBR: EvalLabMessages = {
	...en,
	personasTitle: "Personas",
	personasDesc: "Definições de personas — o setup que cada instância pode selecionar.",
	instancesTitle: "Instâncias",
	instancesDesc: "Execuções de geração: selecione personas ou sorteie, depois gere.",
	endpointsTitle: "Endpoints LLM",
	newPersona: "Nova persona",
	newInstance: "Nova instância",
	newEndpoint: "Novo endpoint",
	edit: "Editar",
	delete: "Excluir",
	confirmDelete: "Confirmar exclusão",
	cancel: "Cancelar",
	save: "Salvar",
	create: "Criar",
	name: "Nome",
	patient: "Paciente",
	doctor: "Médico",
	axes: "Eixos",
	notes: "Notas",
	gender: "Gênero",
	ageBand: "Faixa etária",
	socialClass: "Classe social",
	education: "Escolaridade",
	region: "Região",
	register: "Registro",
	specialty: "Especialidade",
	doctorGender: "Gênero do médico",
	doctorRegister: "Registro do médico",
	emptyDefs: "Nenhuma persona ainda — crie o setup primeiro.",
	emptyInstances: "Nenhuma instância ainda.",
	emptyEndpoints: "Sem endpoints — a geração usa o renderizador de template.",
	mode: "Modo",
	modeSelected: "Personas selecionadas",
	modeRandom: "Amostra aleatória",
	count: "Quantidade",
	seed: "Semente",
	minutes: "Duração da entrevista (min)",
	endpoint: "Endpoint",
	endpointTemplate: "Template (determinístico, sem LLM)",
	kind: "Tipo",
	baseUrl: "URL base",
	model: "Modelo",
	sessionId: "Id de sessão",
	secretRef: "Env var da API key",
	secretRefHint: "Nome da env var que guarda a chave — nunca a chave em si.",
	timeoutMs: "Timeout (ms)",
	enabled: "Ativo",
	start: "Gerar",
	test: "Testar",
	testOk: "endpoint ok",
	testFailed: "endpoint falhou",
	openDetail: "Abrir",
	items: "itens",
	progress: "Progresso",
	distribution: "Distribuição da coorte",
	reviewHint: "Personas geradas aguardam revisão no Eval validator.",
	actionFailed: "Ação falhou — verifique permissões e tente de novo.",
	statusDraft: "rascunho",
	statusGenerating: "gerando",
	statusReady: "pronta",
	statusFailed: "falhou",
	statusPending: "pendente",
	statusDone: "concluído",
	statusError: "erro",
	female: "feminino",
	male: "masculino",
	personaPurpose:
		"Uma persona é um perfil reutilizável de paciente + médico. Instances escolhem personas para gerar consultas sintéticas.",
	patientSection: "Paciente",
	doctorSection: "Médico(a)",
	randomize: "Surpreenda-me",
	generatePersonas: "Gerar personas",
	genHint:
		"Um endpoint LLM rascunha as personas; a opção template sorteia a matriz demográfica deterministicamente.",
	genDone: "Personas criadas — aparecem na lista abaixo.",
	spawnGenerators: "Gerar instâncias",
	spawnHint:
		"Cria N instâncias em rascunho “generator #1..N”, cada uma sorteando personas no endpoint escolhido.",
	generators: "Instâncias",
	perGenerator: "Personas por instância",
	transport: "Transporte",
	transportHint: "child/ssh precisam do runtime Node — este app só usa ws.",
	acpHint:
		"Conecta um agente local via ACP (ex.: Claude Code). Sem API key — rode `claude agent acp` e cole o id de sessão.",
	secretRefNone: "Nenhuma",
	secretRefCustom: "Env var personalizada",
	axisLabels: {
		child: "Criança (0-12)",
		adult: "Adulto (18-64)",
		elderly: "Idoso (65+)",
		low: "Renda baixa",
		middle: "Renda média",
		high: "Renda alta",
		primary: "Ensino fundamental",
		secondary: "Ensino médio",
		higher: "Superior+",
		north: "Norte",
		northeast: "Nordeste",
		central: "Centro-Oeste",
		southeast: "Sudeste",
		south: "Sul",
		colloquial: "Coloquial — linguagem simples",
		neutral: "Neutro",
		technical: "Técnico — termos médicos",
		general_practice: "Clínica geral",
		cardiology: "Cardiologia",
		dermatology: "Dermatologia",
		pediatrics: "Pediatria",
	},
};

const es: EvalLabMessages = {
	...ptBR,
	...en,
	personasDesc: "Definiciones de personas — la configuración que cada instancia selecciona.",
	personaPurpose:
		"Una persona es un perfil reutilizable de paciente + médico. Las instancias eligen personas para generar consultas sintéticas.",
	patientSection: "Paciente",
	doctorSection: "Médico/a",
	randomize: "Sorpréndeme",
	generatePersonas: "Generar personas",
	genHint:
		"Un endpoint LLM redacta las personas; la opción template muestrea la matriz demográfica de forma determinista.",
	genDone: "Personas creadas — aparecen en la lista.",
	spawnGenerators: "Generar instancias",
	spawnHint:
		"Crea N instancias en borrador “generator #1..N”, cada una muestreando personas en el endpoint elegido.",
	perGenerator: "Personas por instancia",
	transport: "Transporte",
	transportHint: "child/ssh necesitan el runtime Node — esta app solo usa ws.",
	acpHint:
		"Conecta un agente local vía ACP (p. ej. Claude Code). Sin API key — ejecuta `claude agent acp` y pega el id de sesión.",
	secretRefNone: "Ninguna",
	secretRefCustom: "Env var personalizada",
	axisLabels: {
		child: "Niño/a (0-12)",
		adult: "Adulto (18-64)",
		elderly: "Adulto mayor (65+)",
		low: "Ingresos bajos",
		middle: "Ingresos medios",
		high: "Ingresos altos",
		primary: "Primaria",
		secondary: "Secundaria",
		higher: "Superior+",
		north: "Norte",
		northeast: "Nordeste",
		central: "Centro-Oeste",
		southeast: "Sudeste",
		south: "Sur",
		colloquial: "Coloquial — lenguaje simple",
		neutral: "Neutro",
		technical: "Técnico — términos médicos",
		general_practice: "Clínica general",
		cardiology: "Cardiología",
		dermatology: "Dermatología",
		pediatrics: "Pediatría",
	},
	instancesTitle: "Instancias",
	endpointsTitle: "Endpoints LLM",
	newPersona: "Nueva persona",
	newInstance: "Nueva instancia",
	newEndpoint: "Nuevo endpoint",
	edit: "Editar",
	delete: "Eliminar",
	confirmDelete: "Confirmar eliminación",
	cancel: "Cancelar",
	save: "Guardar",
	create: "Crear",
	name: "Nombre",
	emptyDefs: "Sin personas todavía — crea la configuración primero.",
	emptyInstances: "Sin instancias todavía.",
	start: "Generar",
	test: "Probar",
	openDetail: "Abrir",
	progress: "Progreso",
	actionFailed: "La acción falló — revisa permisos e intenta de nuevo.",
};

export const evalLabMessages = (locale: string): EvalLabMessages =>
	locale === "pt-BR" ? ptBR : locale === "es" ? es : en;
