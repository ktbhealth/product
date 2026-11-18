import type { PtbrConsult } from "./types.ts";

/**
 * Dermatologia — 3 authored consults.
 * Pruritic rash workup, adolescent acne, psoriasis flare follow-up.
 * Noise: symptom descriptions with hedging, topical-medication names
 * and frequencies, negated drug allergies.
 */
export const DERMATOLOGY: readonly PtbrConsult[] = [
	{
		slug: "derm-rash-01",
		specialty: "dermatology",
		region: "southeast",
		ageBand: "adult",
		register: "colloquial",
		gender: "f",
		socialClass: "c",
		education: "secondary",
		patientName: "Paciente Lia",
		doctor: { gender: "f", register: "formal" },
		turns: [
			{ speaker: "doctor", text: "Bom dia, dona Lia. O que que está acontecendo com a sua pele?" },
			{
				speaker: "patient",
				text: "Doutora, eu tô com um negócio na mão que não para de coçar, e já espalhou pro braço também. Faz umas duas semanas, começou como uma bolinha vermelha e foi virando umas placas, sabe? E quando eu coço piora, aí fico num ciclo.",
			},
			{
				speaker: "patient",
				text: "Ah, e eu também comecei a tomar um antibiótico semana passada, a amoxicilina, porque tava com uma infecção de garganta. Será que foi o remédio?",
			},
			{
				speaker: "doctor",
				text: "Interessante que você mencionou a amoxicilina — alguns pacientes fazem reação de pele com antibiótico, mas nem sempre é isso. Deixa eu ver a lesão. ... Hum, tem um padrão aqui que eu quero investigar. Você tem histórico de alergia a remédio?",
			},
			{
				speaker: "patient",
				text: "Tenho sim! Eu sou alérgica a dipiriona, me dá urticária e o lábio incha. Mas amoxicilina eu já usei outras vezes sem problema.",
			},
			{
				speaker: "doctor",
				text: "Anotado, alergia a dipirona — isso é importante. Sobre a amoxicilina, como você tolerou antes, provavelmente não é reação a ela. O quadro parece mais uma dermatite, possivelmente desencadeada por atrito ou produto novo que você usou. Mudou de sabonete, creme, ou começou a usar algo na pele esses dias?",
			},
			{
				speaker: "patient",
				text: "Mudei sim! Comprei um creme hidratante novo, aquela marca da farmácia que é baratinha, uns dez dias atrás. E também tô usando um sabonete antibacteriano porque tô em época de aula.",
			},
			{
				speaker: "doctor",
				text: "Suspeita forte então — creme novo mais sabonete antibacteriano é combinação clássica pra irritar a pele. Vou suspender os dois por enquanto. Pra coceira eu vou passar uma loção de corticoide suave, betametasona, aplicar duas vezes ao dia só nas lesões. E se coçar, tenta segurar — o dano na pele atrasa a cura.",
			},
			{
				speaker: "patient",
				text: "Doutora, e a amoxicilina eu continuo tomando ou paro? Porque a garganta ainda tá meio inflamada.",
			},
			{
				speaker: "doctor",
				text: "Continua a amoxicilina, ela não tem relação com a lesão da pele. Mas me diz: a alergia à dipirona você sabia que tem também alguns anti-inflamatórios que cruzam? Vou evitar te passar qualquer coisa dessa família. Se a lesão não melhorar em uma semana, ou se aparecer bolha, pus, ou febre, volta aqui antes.",
			},
			{
				speaker: "patient",
				text: "Tá bom, doutora. Uma semana então. Muito obrigada, viu?",
			},
			{
				speaker: "doctor",
				text: "Isso. E guarda o creme novo — se for o culpado, não compensa arriscar de novo. Tchau, dona Lia.",
			},
		],
		entities: [
			{ category: "medication", value: "amoxicilina" },
			{ category: "medication", value: "dipirona" },
			{ category: "medication", value: "betametasona" },
			{ category: "frequency", value: "duas vezes ao dia" },
			{ category: "date", value: "uma semana" },
		],
	},
	{
		slug: "derm-acne-02",
		specialty: "dermatology",
		region: "north",
		ageBand: "teen",
		register: "colloquial",
		gender: "f",
		socialClass: "b",
		education: "secondary",
		patientName: "Paciente Sofia",
		doctor: { gender: "f", register: "colloquial" },
		turns: [
			{
				speaker: "doctor",
				text: "Oi, Sofia, tudo bem? E a sua mãe, como tá? Senta aqui do meu lado. O que que tá acontecendo com essa pele?",
			},
			{
				speaker: "patient",
				text: "Doutora, eu tô com muito cravo e espinha no rosto, principalmente na testa e aqui na bochecha. Já faz uns meses, e eu já tentei aquele sabonete de ácido salicílico que a gente comprou na farmácia, mas não adianta muito.",
			},
			{
				speaker: "doctor",
				text: "Deixa eu ver... É, tá bem inflamada essa área. Sofia, você tá usando maquiagem pesada, ou passou a usar algum produto novo no cabelo ou no rosto? E como tá sua alimentação — doce, fritura?",
			},
			{
				speaker: "patient",
				text: "Maquiagem eu uso pouca coisa, só base quando vou sair. Doces eu como bastante, confesso — chocolate, refri, pizza todo fim de semana com a galera.",
			},
			{
				speaker: "doctor",
				text: "Tá, então a gente ataca por dois lados. Primeiro: o sabonete de ácido salicílico pode continuar, mas só uma vez ao dia, de preferência à noite, porque ele resseca a pele. Segundo: vou te passar um creme pra passar nas lesões, adapaleno, uma vez à noite, em camada fina. Ele é um pouco irritante nas duas primeiras semanas — é normal, mas se ardê demais, reduz pra dia sim, dia não.",
			},
			{
				speaker: "patient",
				text: "Doutora, e espinha pode deixar marca ou ficar cacoete? Porque eu já vi gente que ficou com a pele toda marcada.",
			},
			{
				speaker: "doctor",
				text: "Pode deixar marca sim, por isso que a gente trata cedo. E a regra de ouro: não espreme, por mais vontade que dê. Espinha espremida vira marca e às vezes infecção. Se aparecer uma lesão muito inflamada, me avisa que eu avalio se precisa de outro tratamento.",
			},
			{
				speaker: "patient",
				text: "Tá bom. E a alimentação eu posso continuar comendo doce ou tenho que cortar de vez?",
			},
			{
				speaker: "doctor",
				text: "Cortar de vez não precisa, mas reduz. Pizza e doce todo fim de semana não vai funcionar — tenta uma vez por semana, escolhe o dia. E dorme mais cedo: a pele se regenera de noite, sono ruim piora acne. Em um mês eu quero te ver de novo pra avaliar.",
			},
			{
				speaker: "patient",
				text: "Um mês tá bom, doutora. Muito obrigada, viu?",
			},
			{
				speaker: "doctor",
				text: "Isso, e qualquer reação alérgica ao creme — inchaço, vermelhidão forte — para e me procura. Tchau, Sofia, e manda um oi pra sua mãe.",
			},
		],
		entities: [
			{ category: "medication", value: "adapaleno" },
			{ category: "frequency", value: "uma vez à noite" },
			{ category: "medication", value: "ácido salicílico" },
			{ category: "date", value: "um mês" },
		],
	},
	{
		slug: "derm-psoriase-03",
		specialty: "dermatology",
		region: "south",
		ageBand: "adult",
		register: "formal",
		gender: "m",
		socialClass: "a",
		education: "postgraduate",
		patientName: "Paciente Otto",
		doctor: { gender: "m", register: "formal" },
		turns: [
			{
				speaker: "doctor",
				text: "Boa tarde, senhor Otto. Retorno da psoríase — como o senhor está se sentindo desde a última consulta?",
			},
			{
				speaker: "patient",
				text: "Doutor, sinceramente, não muito bem. As placas pioraram no cotovelo e no joelho, e surgiu uma área nova na região sacral. Eu mantive o tratamento que o senhor passou, mas acho que perdi o embalo por causa de uma semana atípica de trabalho.",
			},
			{
				speaker: "doctor",
				text: "Entendo — psoríase é assim, o estresse e a rotina quebrada desencadeiam crises. Deixa eu examinar. ... As placas estão mais hiperemiadas e com mais descamação que o habitual. O senhor usou o corticosteroide tópico conforme prescrito? E suspendeu o betametasona dipropionato em gel?",
			},
			{
				speaker: "patient",
				text: "Usei sim, duas vezes ao dia como combinado, mas vou ser honesto: numa semana de fechamento de projeto eu esqueci algumas aplicações. E o senhor lembra que eu tenho aquela alergia a dipirona? Não usei nada pra coceira por causa disso.",
			},
			{
				speaker: "doctor",
				text: "Perfeito que o senhor lembrou da alergia — isso já está no prontuário, mas reforçar nunca é demais. O problema não foi a adesão sua, foi provavelmente a carga de estresse. Vou ajustar o tratamento: manter o tópico duas vezes ao dia e adicionar uma fototerapia, que é aquela luz ultravioleta na clínica, duas vezes por semana. Em paralelo, vou prescrever um imunossupressor suave pra uso contínuo — metotrexato em dose baixa, uma vez por semana.",
			},
			{
				speaker: "patient",
				text: "Metotrexato, doutor? Eu pesquisei esse nome e fiquei meio preocupado com os efeitos. Tem efeito colateral sério?",
			},
			{
				speaker: "doctor",
				text: "Pergunta correta. Na dose que uso pra psoríase — quinze miligramas por semana — os efeitos são bem controlados, mas exige acompanhamento com exames de sangue a cada mês nos primeiros meses. Se aparecer queda de cabelo, feridas na boca ou febre, o senhor me procura imediatamente. E nada de engravidar durante o tratamento — isso vale pra senhor e pra qualquer parceiro.",
			},
			{
				speaker: "patient",
				text: "Entendido. E a fototerapia, quantas sessões o senhor imagina que eu vou precisar?",
			},
			{
				speaker: "doctor",
				text: "Normalmente de vinte a trinta sessões pra ter melhora significativa, mas varia. Vou te encaminhar pro ambulatório de fototerapia e a gente reavalia em seis semanas. Se a lesão estourar, ficar muito vermelha ou com pus, para o tratamento e vem aqui — não espera.",
			},
			{
				speaker: "patient",
				text: "Combinado, doutor. Vou tentar também melhorar o sono e reduzir o estresse — sei que isso ajuda, mesmo sendo difícil.",
			},
			{
				speaker: "patient",
				text: "Ah, e doutor, uma coisa: a lesão na região sacral, aquela área nova — é normal surgir em local diferente?",
			},
			{
				speaker: "doctor",
				text: "É, psoríase pode surgir em áreas de atrito ou trauma leve, e a região sacral é comum por causa do atrito com a roupa. Não é alarme, mas fica de olho — se doer muito ou mudar de aspecto, me avisa. Seis semanas, então, com os exames de sangue marcados. Tchau, senhor Otto.",
			},
		],
		entities: [
			{ category: "medication", value: "metotrexato" },
			{ category: "dosage", value: "quinze miligramas" },
			{ category: "frequency", value: "duas vezes por semana" },
			{ category: "frequency", value: "duas vezes ao dia" },
			{ category: "date", value: "seis semanas" },
		],
	},
];
