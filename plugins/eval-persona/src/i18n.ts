/** Eval lab copy — one typed catalog per locale, resolved from the
 * panel page ctx (same contract as eval-validator's i18n). */
export const EVAL_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "eval.persona";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): EvalLabMessages => evalLabMessages(locale);

export interface EvalLabMessages {
	readonly personasTitle: string;
	readonly personasDesc: string;
	readonly instancesTitle: string;
	readonly instancesDesc: string;
	readonly stepPersonas: string;
	readonly stepGenerate: string;
	readonly stepRunEval: string;
	readonly pipelineAria: string;
	readonly newPersona: string;
	readonly newInstance: string;
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
	readonly mode: string;
	readonly modeSelected: string;
	readonly modeRandom: string;
	readonly count: string;
	readonly seed: string;
	readonly minutes: string;
	readonly endpoint: string;
	readonly endpointTemplate: string;
	readonly start: string;
	readonly openDetail: string;
	readonly items: string;
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
	readonly axisLabels: Record<string, string>;
}

const en: EvalLabMessages = {
	personasTitle: "Personas",
	personasDesc: "Curated persona definitions — the eval setup each instance can pick.",
	instancesTitle: "Instances",
	instancesDesc: "Generation runs: pick personas or sample randomly, then generate.",
	stepPersonas: "1 · Personas",
	stepGenerate: "2 · Generate consultations",
	stepRunEval: "3 · Run eval",
	pipelineAria: "Eval pipeline",
	newPersona: "New persona",
	newInstance: "New instance",
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
	mode: "Mode",
	modeSelected: "Selected personas",
	modeRandom: "Random sample",
	count: "Count",
	seed: "Seed",
	minutes: "Interview length (min)",
	endpoint: "Endpoint",
	endpointTemplate: "Template (deterministic, no LLM)",
	start: "Generate",
	openDetail: "Open",
	items: "items",
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
	stepPersonas: "1 · Personas",
	stepGenerate: "2 · Gerar consultas",
	stepRunEval: "3 · Rodar eval",
	pipelineAria: "Pipeline de eval",
	newPersona: "Nova persona",
	newInstance: "Nova instância",
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
	mode: "Modo",
	modeSelected: "Personas selecionadas",
	modeRandom: "Amostra aleatória",
	count: "Quantidade",
	seed: "Semente",
	minutes: "Duração da entrevista (min)",
	endpoint: "Endpoint",
	endpointTemplate: "Template (determinístico, sem LLM)",
	start: "Gerar",
	openDetail: "Abrir",
	items: "itens",
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
	personasTitle: "Personas",
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
	instancesDesc: "Ejecuciones de generación: elige personas o muestrea al azar, luego genera.",
	stepPersonas: "1 · Personas",
	stepGenerate: "2 · Generar consultas",
	stepRunEval: "3 · Ejecutar eval",
	pipelineAria: "Pipeline de eval",
	newPersona: "Nueva persona",
	newInstance: "Nueva instancia",
	edit: "Editar",
	delete: "Eliminar",
	confirmDelete: "Confirmar eliminación",
	cancel: "Cancelar",
	save: "Guardar",
	create: "Crear",
	name: "Nombre",
	patient: "Paciente",
	doctor: "Médico",
	axes: "Ejes",
	notes: "Notas",
	gender: "Género",
	ageBand: "Rango de edad",
	socialClass: "Clase social",
	education: "Educación",
	region: "Región",
	register: "Registro",
	specialty: "Especialidad",
	doctorGender: "Género del médico",
	doctorRegister: "Registro del médico",
	emptyDefs: "Sin personas todavía — crea la configuración primero.",
	emptyInstances: "Sin instancias todavía.",
	mode: "Modo",
	modeSelected: "Personas seleccionadas",
	modeRandom: "Muestra aleatoria",
	count: "Cantidad",
	seed: "Semilla",
	minutes: "Duración de la entrevista (min)",
	endpoint: "Endpoint",
	endpointTemplate: "Template (determinista, sin LLM)",
	start: "Generar",
	openDetail: "Abrir",
	items: "elementos",
	distribution: "Distribución de la cohorte",
	reviewHint: "Las personas generadas esperan revisión en Eval validator.",
	actionFailed: "La acción falló — revisa permisos e intenta de nuevo.",
	statusDraft: "borrador",
	statusGenerating: "generando",
	statusReady: "lista",
	statusFailed: "fallida",
	statusPending: "pendiente",
	statusDone: "hecho",
	statusError: "error",
	female: "femenino",
	male: "masculino",
	generators: "Generadores",
};

export const evalLabMessages = (locale: string): EvalLabMessages =>
	locale === "pt-BR" ? ptBR : locale === "es" ? es : en;
