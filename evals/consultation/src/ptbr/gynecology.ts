import type { PtbrConsult } from "./types.ts";

/**
 * Ginecologia — 3 authored consults.
 * Dysmenorrhea/pelvic pain, Pap-smear follow-up, menopausal symptoms.
 * Noise: sensitive-topic register, negated pregnancy, cycle dates.
 */
export const GYNECOLOGY: readonly PtbrConsult[] = [
	{
		slug: "gine-colica-01",
		specialty: "gynecology",
		region: "southeast",
		ageBand: "adult",
		register: "colloquial",
		gender: "f",
		socialClass: "c",
		education: "secondary",
		patientName: "Paciente Helena",
		doctor: { gender: "f", register: "formal" },
		turns: [
			{
				speaker: "doctor",
				text: "Boa tarde, dona Helena. Pode sentar, fique à vontade. O que que a senhora gostaria de conversar hoje?",
			},
			{
				speaker: "patient",
				text: "Doutora, eu vim porque esses dias eu tô sentindo uma cólica forte embaixo da barriga, principalmente na época da menstruação. Mas dessa vez tá diferente, tá doendo até fora do período, uns dias antes e depois. E eu tô muito estressada com o trabalho, será que é por causa disso?",
			},
			{
				speaker: "doctor",
				text: "A cólica que a senhora descreve pode ser de várias causas, e o estresse realmente pode piorar. Deixa eu te perguntar: a senhora é sexualmente ativa? Usa algum método contraceptivo? E a menstruação tá vindo regular ou mudou de padrão?",
			},
			{
				speaker: "patient",
				text: "Sou ativa sim, e eu uso preservativo, não tomo anticoncepcional. A menstruação eu acho que tá mais ou menos regular, mas esse mês atrasou uns cinco dias e veio pouco, diferente do normal.",
			},
			{
				speaker: "doctor",
				text: "Atraso de cinco dias com menstruação escassa — a senhora tem chance de estar grávida? Mesmo usando preservativo, acontece. Vamos considerar essa possibilidade. Você tem náusea, senão de peito ou cansaço diferente?",
			},
			{
				speaker: "patient",
				text: "Náusea eu tenho um pouquinho de manhã, e os seios tão meio doloridos, mas pode ser TPM também, né? Porque eu nunca sei distinguir.",
			},
			{
				speaker: "doctor",
				text: "Pode ser TPM mesmo, mas vamos confirmar. Vou pedir um teste de gravidez — a senhora faz em casa ou prefere aqui? E enquanto isso, pra cólica eu passo um antiespasmódico, escopolamina, um comprimido de vinte miligramas, até três vezes ao dia se precisar. Se o teste der positivo, a senhora volta aqui pra gente conversar sobre pré-natal; se der negativo, investigamos outra causa.",
			},
			{
				speaker: "patient",
				text: "Escopolamina, doutora? Eu nunca tomei esse remédio. Ele dá sono? Porque eu preciso trabalhar.",
			},
			{
				speaker: "doctor",
				text: "Dá um sono leve sim, então tome à noite se possível, ou em dose menor durante o dia. E a senhora tem alergia a algum remédio?",
			},
			{
				speaker: "patient",
				text: "Alergia eu não tenho de remédio nenhum, graças a Deus. Só que eu tô com medo do teste, doutora, porque se for positivo eu não sei o que fazer.",
			},
			{
				speaker: "doctor",
				text: "Entendo o medo, mas informação é o primeiro passo — seja qual for o resultado, a senhora não está sozinha nisso. E se a cólica piorar muito, se vier sangramento fora do período ou febre, não espera o teste: vem aqui ou na emergência. Combinado?",
			},
			{
				speaker: "patient",
				text: "Combinado, doutora. Eu faço o teste hoje mesmo então e te ligo com o resultado?",
			},
			{
				speaker: "doctor",
				text: "Perfeito, me liga ou volta aqui amanhã. A recepção já te passa o teste. Qualquer coisa, me procura. Tchau, dona Helena.",
			},
		],
		entities: [
			{ category: "medication", value: "escopolamina" },
			{ category: "dosage", value: "vinte miligramas" },
			{ category: "frequency", value: "até três vezes ao dia" },
			{ category: "negation", value: "Alergia eu não tenho" },
		],
	},
	{
		slug: "gine-preventivo-02",
		specialty: "gynecology",
		region: "south",
		ageBand: "adult",
		register: "formal",
		gender: "f",
		socialClass: "b",
		education: "higher",
		patientName: "Paciente Sofia",
		doctor: { gender: "f", register: "formal" },
		turns: [
			{
				speaker: "doctor",
				text: "Boa tarde, senhora Sofia. É um retorno de rotina, correto? Como a senhora tem se sentido?",
			},
			{
				speaker: "patient",
				text: "Boa tarde, doutora. Sim, é o preventivo anual. Eu tô bem, sem sintomas, mas confesso que fiquei um pouco ansiosa porque da última vez o resultado do Papanicolau demorou e eu não sabia se era normal.",
			},
			{
				speaker: "doctor",
				text: "Sua ansiedade é compreensível, mas dessa vez o resultado já está aqui. Deixa eu ver... O Papanicolau deu negativo para lesão, o que é o resultado normal — a senhora está dentro da faixa etária certa pra continuar o rastreamento anual. E o restante do exame físico está tudo normal.",
			},
			{
				speaker: "patient",
				text: "Que alívio, doutora. E sobre a mamografia, eu tenho quarenta e cinco anos, já é hora de fazer?",
			},
			{
				speaker: "doctor",
				text: "Sim, aos quarenta e cinco a gente já indica mamografia de rastreamento, especialmente com histórico familiar — e a senhora mencionou que a mãe teve câncer de mama, correto? Vou fazer o encaminhamento hoje. E a senhora faz autoexame das mamas regularmente?",
			},
			{
				speaker: "patient",
				text: "Faço sim, todo mês depois da menstruação. E eu tenho uma dúvida: a senhora pode me explicar de novo sobre os sinais que eu devo observar em casa? Porque às vezes eu acho nódulo mas não sei se é normal.",
			},
			{
				speaker: "doctor",
				text: "Claro. O autoexame é depois da menstruação, em pé e deitada, procurando nódulos, retrações de pele, ou secreção no mamilo que não seja leitosa. Se encontrar qualquer nódulo duro, fixo, que não mexe, ou secreção sanguinolenta, não espera a consulta anual — marca uma avaliação em até duas semanas. E lembra: a maioria dos nódulos é benigna, mas só o exame confirma.",
			},
			{
				speaker: "patient",
				text: "Entendido, doutora. E sobre anticoncepção, eu uso DIU hormonal há dois anos e tô bem, mas queria saber se devo trocar por algo diferente agora que entrei na faixa dos quarenta.",
			},
			{
				speaker: "doctor",
				text: "O DIU hormonal é uma excelente escolha e pode continuar até a menopausa, a menos que a senhora tenha alguma contraindicação nova — o que não é o caso. Mas como a senhora mencionou que está pensando em família, vou aproveitar pra perguntar: ainda tem planos de engravidar ou já fechou essa fase?",
			},
			{
				speaker: "patient",
				text: "Já fechei, doutora. Os filhos estão grandes, então não preciso mais me preocupar com isso. Mas queria só confirmar que o DIU é seguro nessa idade.",
			},
			{
				speaker: "doctor",
				text: "É seguro sim, e a eficácia não diminui com a idade. Só vamos precisar trocar o DIU a cada cinco anos, o que já está no calendário. A recepção te passa o encaminhamento da mamografia e o agendamento do próximo preventivo — em um ano, tá? E qualquer sangramento fora do padrão, secreção ou dor pélvica persistente, me procura antes. Combinado?",
			},
			{
				speaker: "patient",
				text: "Combinado, doutora. Muito obrigada pela paciência em explicar tudo de novo. Até o próximo ano, então.",
			},
			{
				speaker: "doctor",
				text: "Disponha, senhora Sofia. O preventivo é a melhor ferramenta que a senhora tem — não pule. Tchau.",
			},
		],
		entities: [
			{ category: "date", value: "um ano" },
			{ category: "date", value: "duas semanas" },
			{ category: "frequency", value: "cinco anos" },
			{ category: "negation", value: "sem sintomas" },
		],
	},
	{
		slug: "gine-menopausa-03",
		specialty: "gynecology",
		region: "south",
		ageBand: "adult",
		register: "colloquial",
		gender: "f",
		socialClass: "d",
		education: "elementary",
		patientName: "Paciente Marta",
		doctor: { gender: "f", register: "colloquial" },
		turns: [
			{
				speaker: "doctor",
				text: "Oi, dona Marta, tudo bom? Senta aqui, minha filha. O que que tá te trazendo hoje?",
			},
			{
				speaker: "patient",
				text: "Ai, doutora, é que eu tô numa fase difícil. Faz uns seis meses que minha menstruação parou de vez, e junto veio um calorão que não para, principalmente à noite. Eu acordo ensopada, o coração dispara, e não consigo dormir. E tem dia que eu fico meio pra baixo, sem vontade de fazer nada.",
			},
			{
				speaker: "doctor",
				text: "Dona Marta, o que você tá descrevendo é clássico da menopausa — a parada da menstruação mais os fogachos e a mudança de humor. Você tem cinquenta e dois anos, então tá na idade certa. Você já conversou sobre isso com alguém da família ou seu médico da UBS?",
			},
			{
				speaker: "patient",
				text: "Conversei com minha filha, mas ela trabalha o dia todo e não pode vir comigo. Com o médico do posto eu não quis falar porque ele é homem e eu tenho vergonha, né? Mas a senhora é mulher, aí eu me abro mais.",
			},
			{
				speaker: "doctor",
				text: "Fico feliz que a senhora se sinta à vontade aqui. Vamos ver o que a gente pode fazer. Você tem pressão alta, diabetes, ou histórico de câncer na família? E usa algum remédio contínuo?",
			},
			{
				speaker: "patient",
				text: "Pressão eu tenho sim, tomo losartana cinquenta miligramas de manhã. Diabetes não tenho. Câncer na família minha mãe teve de mama, mas eu faço o preventivo certinho. Remédio de uso contínuo é só a losartana mesmo.",
			},
			{
				speaker: "doctor",
				text: "Anotado. Com a sua pressão e o histórico de câncer de mama da mãe, a gente precisa avaliar com cuidado se a reposição hormonal é indicada pra senhora — nem sempre é, depende do perfil de risco. Mas antes de decidir, vou pedir uns exames: dosagem hormonal, avaliação do útero e dosagem de cálcio pra ver como tá o osso. Enquanto isso, pra dormir melhor e aliviar os fogachos, vou te passar algumas orientações e um remédio leve.",
			},
			{
				speaker: "patient",
				text: "Remédio leve, doutora? Tipo o quê? Porque eu tenho medo de remédio forte nessa idade.",
			},
			{
				speaker: "doctor",
				text: "Não é remédio forte não, é mais pra ajudar na qualidade de vida. Vou passar paracetamol pra quando o calorão vier, e uma medicação pra dormir melhor à noite, mas em dose baixa e por tempo limitado. E o mais importante: a senhora precisa de suporte — conversar com a filha, participar de um grupo de mulheres na UBS, ou vir aqui mais vezes se precisar. A menopausa não é doença, mas merece atenção.",
			},
			{
				speaker: "patient",
				text: "Tá bom, doutora. Eu nunca tinha pensado que podia ter ajuda pra isso, achei que era só aguentar mesmo. Quando eu volto com os exames?",
			},
			{
				speaker: "doctor",
				text: "Em uns quinze dias eu quero te ver com os resultados, tá? E se os fogachos piorarem muito, se vier sangramento vaginal depois da menopausa — isso sim é sinal de alerta e você vem na hora — ou se a senhora se sentir muito pra baixo a ponto de não conseguir as coisas de casa, me procura antes dos quinze dias. Combinado?",
			},
			{
				speaker: "patient",
				text: "Combinado, doutora. Muito obrigada por me ouvir, viu? Senti que a senhora leva a sério.",
			},
			{
				speaker: "doctor",
				text: "Levo sim, dona Marta, e a senhora merecia ter vindo antes. Quinze dias, então. Qualquer coisa me liga. Tchau, minha filha.",
			},
		],
		entities: [
			{ category: "medication", value: "losartana" },
			{ category: "dosage", value: "cinquenta miligramas" },
			{ category: "medication", value: "paracetamol" },
			{ category: "date", value: "quinze dias" },
		],
	},
];
