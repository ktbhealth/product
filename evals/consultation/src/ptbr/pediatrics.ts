import type { PtbrConsult } from "./types.ts";

/**
 * Pediatria — 3 authored consults.
 * Guardian-mediated infant/child consults (fever, otitis) and a teen
 * headache consult. The "patient" speaker is the caregiver for
 * minors — realistic pt-BR parent register, weight-based dosing,
 * return precautions.
 */
export const PEDIATRICS: readonly PtbrConsult[] = [
	{
		slug: "ped-febre-01",
		specialty: "pediatrics",
		region: "southeast",
		ageBand: "child",
		register: "colloquial",
		gender: "m",
		socialClass: "c",
		education: "secondary",
		patientName: "Paciente Davi",
		doctor: { gender: "f", register: "colloquial" },
		turns: [
			{
				speaker: "doctor",
				text: "Oi, dona Ana, tudo bem? E o Davi, como tá? Senta aqui, vamos ver esse menino.",
			},
			{
				speaker: "patient",
				text: "Doutora, o Davi tá com febre desde ontem à noite, uns trinta e oito e meio. Ele tava bem de tarde, aí de repente começou a ficar quentinho, choroso, sem querer comer. De madrugada deu trinta e nove. Eu já dei dipirona mas baixou só um pouquinho.",
			},
			{
				speaker: "doctor",
				text: "Deixa eu ver ele aqui. ... Ele tá meio paradinho, mas quando eu chamo ele responde. Dona Ana, ele toma quantos miligramas de dipirona você deu? E o peso dele, você sabe mais ou menos?",
			},
			{
				speaker: "patient",
				text: "Eu dei uma ampola de novecentos miligramas dissolvida na água, como o farmacêutico me explicou. O peso dele eu acho que é uns vinte e quatro quilos, foi pesado mês passado no posto.",
			},
			{
				speaker: "doctor",
				text: "Vinte e quatro quilos, então a dose tá certa. Deixa eu examinar a garganta e o ouvido dele... A garganta tá um pouco inflamada, o ouvido direito tá meio avermelhado também. Pode ser uma infecção de garganta com otite associada — coisa comum nessa idade. Ele tem alergia a algum remédio?",
			},
			{
				speaker: "patient",
				text: "Alergia ele não tem nenhuma, graças a Deus. Só que ele é meio enjoadinho, qualquer remédio novo ele vomita, então eu fico com medo de dar antibiotic.",
			},
			{
				speaker: "doctor",
				text: "Justamente por isso vou passar um antibiótico mais suave, amoxicilina, em suspensão, porque em cápsula ele não consegue engolir. A dose é por peso: cinco miligramas por quilo, de oito em oito horas, por dez dias. E a dipirona continua pra febre, mas respeitando o intervalo de seis horas entre uma dose e outra.",
			},
			{
				speaker: "patient",
				text: "De oito em oito horas, doutora? São três vezes ao dia, então? E se ele vomitar o remédio, eu dou de novo ou espero?",
			},
			{
				speaker: "doctor",
				text: "Se vomitar logo depois de tomar, espera uns trinta minutos e dá de novo. Se vomitar muito depois, deixa pra próxima dose. E ó, dona Ana, sinais de alarme: se ele ficar muito sonolento, não responder quando você chama, ou aparecer mancha roxa na pele, ou convulsão — isso é emergência, vem aqui na hora ou no pronto-socorro, tá?",
			},
			{
				speaker: "patient",
				text: "Tá bom, doutora, anotado. E ele pode ir pra escola ou fica em casa?",
			},
			{
				speaker: "doctor",
				text: "Fica em casa até a febre baixar por pelo menos vinte e quatro horas sem dipirona — febre que some só com remédio volta. Muita hidratação, soro caseiro se ele não quiser comer. Em dois dias eu quero ver ele de novo pra conferir o ouvido.",
			},
			{
				speaker: "patient",
				text: "Dois dias, tá bom. Muito obrigada, doutora. Deus abençoe.",
			},
			{
				speaker: "doctor",
				text: "Imagina. Qualquer piora, não espera — me procura. Tchau, dona Ana, e manda ele um beijo.",
			},
		],
		entities: [
			{ category: "medication", value: "amoxicilina" },
			{ category: "dosage", value: "cinco miligramas" },
			{ category: "frequency", value: "de oito em oito horas" },
			{ category: "date", value: "dez dias" },
			{ category: "date", value: "dois dias" },
			{ category: "negation", value: "Alergia ele não tem" },
		],
	},
	{
		slug: "ped-otite-02",
		specialty: "pediatrics",
		region: "south",
		ageBand: "child",
		register: "colloquial",
		gender: "f",
		socialClass: "b",
		education: "secondary",
		patientName: "Paciente Sofia",
		doctor: { gender: "m", register: "colloquial" },
		turns: [
			{
				speaker: "doctor",
				text: "Oi, dona Carla, tudo certo? E a Sofia, cadê a moça? Senta aqui, vamos ver o que tá acontecendo.",
			},
			{
				speaker: "patient",
				text: "Doutor, a Sofia tá com o ouvido direito doendo faz uns três dias, e ela não para de mexer na orelha, coça sem parar. Ontem à noite ela não dormiu direito, chorou bastante. Ela tem quatro anos.",
			},
			{
				speaker: "doctor",
				text: "Quatro anos, mexendo na orelha e chorando à noite — cheiro de otite. Deixa eu ver com o otoscópio... Sim, o tímpano tá avermelhado e com líquido atrás, é otite média mesmo. Ela teve resfriado ou gripe esses dias?",
			},
			{
				speaker: "patient",
				text: "Teve sim, uns dez dias atrás ela tava com coriza e tosse, mas já melhorou. E ela não tem febre agora, tá só a dor mesmo. Remédio ela não toma nenhum contínuo.",
			},
			{
				speaker: "doctor",
				text: "Perfeito, o resfriado explicando a otite. Vou passar um antibiótico, amoxicilina de novo, mas dessa vez em cápsula porque ela já consegue engolir — dose de quarenta miligramas por quilo ao dia, dividida em três tomadas, por dez dias. Pra dor eu passo também paracetamino, gotinhas, de seis em seis horas se precisar. E compressa morna no ouvido ajuda ela a dormir.",
			},
			{
				speaker: "patient",
				text: "Compressa morna, tá. E doutor, ela tem alergia a algum remédio? Porque da outra vez o antibiótico deu uma alergia nela, ficou vermelha toda.",
			},
			{
				speaker: "doctor",
				text: "Ah, isso é importante, dona Carla — então a gente troca. Em vez de amoxicilina eu vou usar azitromicina, que tem menos reação cruzada. A dose é cinco miligramas por quilo uma vez ao dia, por cinco dias. Se ela desenvolver coceira, manchas ou inchaço depois de tomar, para e me traz aqui.",
			},
			{
				speaker: "patient",
				text: "Tá bom, doutor. E ela pode ir pra escola ou fica em casa?",
			},
			{
				speaker: "doctor",
				text: "Como não tem febre, pode ir amanhã normal. Mas se aparecer febre, secreção saindo do ouvido, ou ela ficar muito quietinha demais — criança quieta demais é sinal de alarme — você traz na hora. Em uma semana eu quero ver ela de novo pra conferir se o líquido secou.",
			},
			{
				speaker: "patient",
				text: "Uma semana, tá bom. Muito obrigada, doutor. A senhora... digo, o senhor é muito cuidadoso.",
			},
			{
				speaker: "doctor",
				text: "Que isso. Otite é chata mas resolve rapidinho com o tratamento certo. Qualquer coisa me liga. Tchau, dona Carla.",
			},
		],
		entities: [
			{ category: "medication", value: "azitromicina" },
			{ category: "dosage", value: "cinco miligramas" },
			{ category: "frequency", value: "uma vez ao dia" },
			{ category: "date", value: "cinco dias" },
			{ category: "date", value: "uma semana" },
		],
	},
	{
		slug: "ped-cefaleia-teen-03",
		specialty: "pediatrics",
		region: "northeast",
		ageBand: "teen",
		register: "colloquial",
		gender: "m",
		socialClass: "c",
		education: "secondary",
		patientName: "Paciente Rui",
		doctor: { gender: "f", register: "colloquial" },
		turns: [
			{
				speaker: "doctor",
				text: "Oi, Rui, beleza? Senta aqui. E aí, o que que tá te trazendo no consultório hoje?",
			},
			{
				speaker: "patient",
				text: "Doutora, é que eu ando com dor de cabeça quase todo dia, principalmente de tarde, quando tô na escola. É uma dor aqui na têmpora, do lado, que fica pulsando. Começou uns dois meses atrás, quando voltou as aulas.",
			},
			{
				speaker: "doctor",
				text: "Dois meses de dor quase diária — isso já é bastante. A dor é só de um lado ou dos dois? E você sente náusea, luz incomodando, ou precisa ficar no escuro?",
			},
			{
				speaker: "patient",
				text: "É mais do lado direito, mas às vezes muda. Luz incomoda sim, e quando tá forte eu sinto um pouco de náusea, mas não chego a vomitar. E eu perco o foco na aula, aí fico mal-humorado com todo mundo.",
			},
			{
				speaker: "doctor",
				text: "Luz incomodando e náusea são sinais de enxaqueca, que é uma dor de cabeça específica — não é só 'dor de cabeça comum'. Rui, como tá sua rotina? Você dorme quantas horas? Está comendo direito ou pulando refeição?",
			},
			{
				speaker: "patient",
				text: "Doutora, dormir eu durmo umas seis horas, porque fico no celular até tarde. Comida eu almoço na escola mas janto tarde, e breakfast eu pulo direto quase todo dia porque dá sono.",
			},
			{
				speaker: "doctor",
				text: "Aí tá a raiz do problema, Rui. Enxaqueca tem gatilho, e sono ruim, pular café da manhã e estresse de escola são os três maiores. A gente vai atacar por dois lados: primeiro, ajustar a rotina — dormir oito horas, tomar café da manhã nem que seja rápido, e limitar o celular depois das dez da noite. Segundo, quando a dor vier, você pode tomar paracetamol, quinientos miligramas, e deitar no escuro por vinte minutos. Mas o remédio é pra alívio, não pra rotina — se precisar tomar mais de dois dias na semana, a gente conversa sobre preventivo.",
			},
			{
				speaker: "patient",
				text: "Doutora, e se eu não conseguir dormir oito horas por causa da escola e das provas? É impossível.",
			},
			{
				speaker: "doctor",
				text: "Não é impossível, é difícil — mas a gente tenta o possível. Mesmo que seja sete horas em semana de prova, já ajuda. E me fala: você sente a dor só em dia de prova ou também nos dias normais? E tem histórico de enxaqueca na família, sua mãe ou pai?",
			},
			{
				speaker: "patient",
				text: "Minha mãe tem, ela toma remédio pra cabeça todo dia. E a dor vem mais em dia de prova mesmo, mas também tem dia normal que ela aparece do nada.",
			},
			{
				speaker: "doctor",
				text: "História familiar de enxaqueca fecha o diagnóstico, Rui. Então o plano é esse: rotina de sono e alimentação, paracetamol só quando precisar, e um diário de dor — anota quando dói, o que comeu, quanto dormiu. Em um mês você traz o diário pra gente avaliar se precisa de preventivo. E sinais de alarme: se a dor mudar de padrão, ficar muito mais forte, ou vier com vômito sem parar, visão embaçada ou fraqueza — vem na emergência, tá?",
			},
			{
				speaker: "patient",
				text: "Tá bom, doutora. Eu vou tentar. E o diário eu posso fazer no celular mesmo, né?",
			},
			{
				speaker: "doctor",
				text: "Pode, aliás é melhor — mais fácil de anotar. Um mês, então. E tenta falar com seus pais sobre isso, porque eles precisam saber que não é frescura, é enxaqueca mesmo. Tchau, Rui.",
			},
		],
		entities: [
			{ category: "medication", value: "paracetamol" },
			{ category: "dosage", value: "quinientos miligramas" },
			{ category: "frequency", value: "vinte minutos" },
			{ category: "date", value: "um mês" },
		],
	},
];
