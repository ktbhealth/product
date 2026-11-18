export interface AiModelMessages {
	readonly title: string;
	readonly subtitle: string;
	readonly add: string;
	readonly edit: string;
	readonly empty: string;
	readonly name: string;
	readonly modelId: string;
	readonly endpointId: string;
	readonly kind: string;
	readonly capabilities: string;
	readonly contextTokens: string;
	readonly costTier: string;
	readonly isDefault: string;
	readonly enabled: string;
	readonly save: string;
	readonly cancel: string;
	readonly delete: string;
	readonly confirmDelete: string;
	readonly actionFailed: string;
	readonly kindHint: string;
}

const en: AiModelMessages = {
	title: "AI models",
	subtitle: "Model catalog — the registry consumers resolve against.",
	add: "Add model",
	edit: "Edit model",
	empty: "No models yet — add the first catalog entry.",
	name: "Name",
	modelId: "Model ID",
	endpointId: "Endpoint",
	kind: "Kind",
	capabilities: "Capabilities",
	contextTokens: "Context tokens",
	costTier: "Cost tier",
	isDefault: "Default",
	enabled: "Enabled",
	save: "Save",
	cancel: "Cancel",
	delete: "Delete",
	confirmDelete: "Delete this model? Consumers resolving it will get null.",
	actionFailed: "Action failed — check permissions and try again.",
	kindHint: "chat/vision/asr/tts/judge/embed — what the model serves.",
};

const ptBR: AiModelMessages = {
	title: "Modelos de IA",
	subtitle: "Catálogo de modelos — o registro que os consumidores resolvem.",
	add: "Adicionar modelo",
	edit: "Editar modelo",
	empty: "Nenhum modelo ainda — adicione a primeira entrada do catálogo.",
	name: "Nome",
	modelId: "ID do modelo",
	endpointId: "Endpoint",
	kind: "Tipo",
	capabilities: "Capacidades",
	contextTokens: "Tokens de contexto",
	costTier: "Faixa de custo",
	isDefault: "Padrão",
	enabled: "Ativo",
	save: "Guardar",
	cancel: "Cancelar",
	delete: "Eliminar",
	confirmDelete: "Eliminar este modelo? Consumidores que o resolverem receberão null.",
	actionFailed: "A ação falhou — verifique permissões e tente de novo.",
	kindHint: "chat/vision/asr/tts/judge/embed — o que o modelo serve.",
};

const es: AiModelMessages = {
	title: "Modelos de IA",
	subtitle: "Catálogo de modelos — el registro que los consumidores resuelven.",
	add: "Añadir modelo",
	edit: "Editar modelo",
	empty: "Sin modelos aún — añade la primera entrada del catálogo.",
	name: "Nombre",
	modelId: "ID del modelo",
	endpointId: "Endpoint",
	kind: "Tipo",
	capabilities: "Capacidades",
	contextTokens: "Tokens de contexto",
	costTier: "Nivel de coste",
	isDefault: "Predeterminado",
	enabled: "Activo",
	save: "Guardar",
	cancel: "Cancelar",
	delete: "Eliminar",
	confirmDelete: "¿Eliminar este modelo? Los consumidores que lo resuelvan recibirán null.",
	actionFailed: "La acción falló — revisa permisos e intenta de nuevo.",
	kindHint: "chat/vision/asr/tts/judge/embed — lo que el modelo sirve.",
};

export const aiModelMessages = (locale: string): AiModelMessages =>
	locale.startsWith("pt") ? ptBR : locale.startsWith("es") ? es : en;
