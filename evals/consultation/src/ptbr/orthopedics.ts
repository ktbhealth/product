import type { PtbrConsult } from "./types.ts";

/**
 * Ortopedia — 3 authored consults.
 * Knee pain post-fall, hip pain in elderly, low-back strain in a
 * young adult worker. Noise: mechanism-of-injury narratives,
 * medication cautions (GI/renal), referral logistics.
 */
export const ORTHOPEDICS: readonly PtbrConsult[] = [
	{
		slug: "ort-jomadao-01",
		specialty: "orthopedics",
		region: "southeast",
		ageBand: "adult",
		register: "colloquial",
		gender: "m",
		socialClass: "c",
		education: "secondary",
		patientName: "Paciente Davi",
		doctor: { gender: "m", register: "colloquial" },
		turns: [
			{
				speaker: "doctor",
				text: "Fala, Davi, beleza? Chega mais, senta ali. O que que aconteceu com esse joelho?",
			},
			{
				speaker: "patient",
				text: "Então, doutor, é que eu caí de bicicleta semana passada, numa descida, e bati o joelho direito no chão. Na hora inchou na hora, ficou desse tamanho... e agora tá doendo pra caramba, principalmente quando eu subo escada ou fico muito tempo sentado.",
			},
			{
				speaker: "doctor",
				text: "Inchou muito? Consegue esticar a perna toda? E dói quando eu apalpar aqui em cima da rótula? ... Essa região tá bem inflamada. Você consegue apoiar o pé no chão e dar uma pressionada?",
			},
			{
				speaker: "patient",
				text: "Apoiar eu consigo, mas dói pra caramba. E o joelho trava às vezes, sabe? Quando eu tento dobrar ele fica meio duro, aí eu tenho que ficar balançando pra destravar.",
			},
			{
				speaker: "doctor",
				text: "Travar é importante você me contar. Pode ser derrame na articulação ou lesão de menisco. Vou pedir uma radiografia pra ver os ossos e, se precisar, um ultrassom. Sobre remédio: você tem alergia a algo? E toma algum contínuo?",
			},
			{
				speaker: "patient",
				text: "Alergia não tenho de remédio não. Contínuo eu não tomo nada, só aquele ibuprofeno quando a dor aperta, uns quarenta e seiscentos miligramas por dia, repartidos em três vezes.",
			},
			{
				speaker: "doctor",
				text: "Tá, o ibuprofeno pode continuar por enquanto, mas com uma regra: sempre depois de comer, nunca de estômago vazio. E não passa de quatro dias seguido sem me falar — anti-inflamatório seguido por muito tempo irrita o estômago e o rim. Vou te passar também uma pomada pra passar no joelho, diclofenaco gel, três vezes ao dia, que ajuda a desinflamar por fora.",
			},
			{
				speaker: "patient",
				text: "Doutor, e eu posso continuar pedalando ou isso piora? Porque eu uso a bicicleta todo dia pra trabalhar.",
			},
			{
				speaker: "doctor",
				text: "Pedalar agora não — o joelho tá inflamado e cada pedalada é impacto. Mas eu não vou te tirar da bicicleta, hein: em uma semana, se a dor ceder, a gente reavalia. Enquanto isso, anda devagar, evita escada e evita ficar agachado. Gelo na articulação vinte minutos, três vezes ao dia, ajuda muito.",
			},
			{
				speaker: "patient",
				text: "Vinte minutos de gelo três vezes ao dia é muita coisa, doutor, mas eu tento. E se o joelho continuar travando, é caso de cirurgia?",
			},
			{
				speaker: "doctor",
				text: "Se continuar travando depois dos exames, aí sim a gente conversa sobre procedimento, mas muita coisa melhora com fisioterapia e repouso relativo. A recepção marca a radiografia pra essa semana. Se inchar muito mais, ficar vermelho ou com febre, vem aqui antes — não espera.",
			},
			{
				speaker: "patient",
				text: "Fechou, doutor. Valeu, hein? Semana que vem eu volto com o exame.",
			},
			{
				speaker: "doctor",
				text: "Isso. E nada de bicicleta essa semana, hein, Davi — o corpo cobra. Tchau.",
			},
		],
		entities: [
			{ category: "medication", value: "ibuprofeno" },
			{ category: "medication", value: "diclofenaco" },
			{ category: "frequency", value: "três vezes ao dia" },
			{ category: "date", value: "uma semana" },
			{ category: "negation", value: "Alergia não tenho" },
		],
	},
	{
		slug: "ort-quadril-02",
		specialty: "orthopedics",
		region: "northeast",
		ageBand: "elderly",
		register: "colloquial",
		gender: "f",
		socialClass: "d",
		education: "elementary",
		patientName: "Paciente Marta",
		doctor: { gender: "m", register: "colloquial" },
		turns: [
			{
				speaker: "doctor",
				text: "Oi, dona Marta, senta aqui, minha filha. Como que eu posso te ajudar hoje?",
			},
			{
				speaker: "patient",
				text: "Ai, doutor, é esse quadril que não para de doer. Faz uns dois meses que começou, primeiro era só quando eu levantava da cadeira, agora dói até pra eu ir no banheiro. E eu já uso a bengala pra andar, porque sem ela eu fico com medo de cair.",
			},
			{
				speaker: "doctor",
				text: "Dona Marta, com setenta e dois anos e dor que já limita o banheiro, a senhora fez muito bem em vir. A bengala é uma ótima decisão, continua usando. Deixa eu te examinar... Quando eu apalp aqui, dói? E a senhora consegue cruzar as pernas?",
			},
			{
				speaker: "patient",
				text: "Dói sim, doutor, uma dorzinha funda. Cruzar a perna eu não consigo mais, porque trava e dói muito. E tem dia que a dor desce pra coxa, mas não chega no pé não.",
			},
			{
				speaker: "doctor",
				text: "Descer pra coxa é comum no problema de quadril. Vou pedir uma radiografia pra ver como está a articulação. Agora, sobre remédio: a senhora usa losartana pra pressão, né? E tem alergia a algum remédio?",
			},
			{
				speaker: "patient",
				text: "Uso losartana sim, cinquenta miligramas de manhã. Alergia eu não tenho nenhuma, graças a Deus. Só que assim, doutor, remédio pra dor eu tenho medo porque meu estômago é fraco, eu tenho gastrite igual te contei da outra vez.",
			},
			{
				speaker: "doctor",
				text: "Pois é, gastrite complica o tratamento da dor. Então a gente vai com o que é mais suave: paracetamol, um comprimido de setecentos e cinquenta miligramas, de seis em seis horas se precisar, máximo quatro vezes ao dia, sempre depois de comer. Anti-inflamatório eu não vou passar por causa do estômago. E vou te encaminhar pra fisioterapia — lá eles fortalecem o quadril e melhoram o equilíbrio, que é o que mais evita queda.",
			},
			{
				speaker: "patient",
				text: "Fisioterapia de novo, doutor... eu já fui uma vez e cansei. Mas se é pro meu quadril melhorar eu vou, viu? Só não me deixa muito tempo em pé que eu canso.",
			},
			{
				speaker: "doctor",
				text: "Tudo bem, o fisioterapeuta vai respeitar seu limite, a senhora avisa ele que cansa fácil. E dona Marta, duas coisas de casa: nada de subir em cadeira ou escada pra pegar coisa no alto — pede pra alguém, ou usa o pegador de reacher. E tapete em casa, se tiver, é risco de queda, arruma isso.",
			},
			{
				speaker: "patient",
				text: "Tapete eu já tirei quase todos, ainda falta o da sala. Doutor, e se a dor piorar muito de repente, o que eu faço?",
			},
			{
				speaker: "doctor",
				text: "Se a dor ficar insuportável ou a senhora não conseguir mais apoiar a perna, vem aqui ou na emergência. Mas se for só mais forte no mesmo padrão, aumenta o paracetamol dentro do limite e me liga. Em duas semanas eu quero te ver de novo, tá?",
			},
			{
				speaker: "patient",
				text: "Duas semanas, tá bom. Muito obrigada, doutor, o senhor é muito bom com a gente.",
			},
			{
				speaker: "doctor",
				text: "Que isso, dona Marta. Usa a bengala sempre, viu? Melhor prevenir do que remendar. Tchau, minha filha.",
			},
		],
		entities: [
			{ category: "medication", value: "losartana" },
			{ category: "dosage", value: "cinquenta miligramas" },
			{ category: "medication", value: "paracetamol" },
			{ category: "dosage", value: "setecentos e cinquenta miligramas" },
			{ category: "frequency", value: "de seis em seis horas" },
			{ category: "date", value: "duas semanas" },
		],
	},
	{
		slug: "ort-lombar-03",
		specialty: "orthopedics",
		region: "central_west",
		ageBand: "adult",
		register: "colloquial",
		gender: "f",
		socialClass: "c",
		education: "secondary",
		patientName: "Paciente Lia",
		doctor: { gender: "f", register: "colloquial" },
		turns: [
			{
				speaker: "doctor",
				text: "Oi, Lia, tudo bem? Senta aqui, relaxa. O que que tá rolando com a coluna?",
			},
			{
				speaker: "patient",
				text: "Doutora, é que faz uns dez dias eu senti uma fisgada na lombar quando fui levantar um saco de cimento no trabalho. Desde então tá doendo, principalmente quando eu fico muito tempo em pé ou tento me inclinar pra pegar coisa no chão.",
			},
			{
				speaker: "doctor",
				text: "Dez dias com dor ainda é um tempo normal de recuperação, mas vamos ver como tá. A dor desce pra perna? Você sente dormência ou fraqueza?",
			},
			{
				speaker: "patient",
				text: "Desce não, fica só aqui em cima. Dormência não sinto. Mas tá uma dorzinha chata que não deixa eu dormir direito de lado.",
			},
			{
				speaker: "doctor",
				text: "Fica só na lombar então, é o mais comum. Vou te examinar aqui... Quando eu apalp essa região, reproduz a dor? Respira fundo... Pronto. O quadro é compatível com uma lombalgia, que é o músculo e o ligamento inflamadinho. Não precisa de exame agora — se não houver sinal de alarme, a gente trata com o básico.",
			},
			{
				speaker: "patient",
				text: "Alarme, como assim, doutora? Tipo o que?",
			},
			{
				speaker: "doctor",
				text: "Tipo perda de força na perna, dormência em área de saia de cômoda — sabe aquela região da perna? — ou perda de controle do xixi e do cocô. Se aparecer qualquer um desses, você vem na emergência na hora, tá? Mas pelo que você me conta, é muscular mesmo.",
			},
			{
				speaker: "patient",
				text: "Tá bom, anotado. E o tratamento, doutora? Porque eu preciso trabalhar, não posso ficar parada.",
			},
			{
				speaker: "doctor",
				text: "Tranquilo, dá pra trabalhar com algumas adaptações. Vou passar um relaxante muscular, ciclobenzaprina, um comprimido à noite antes de dormir, por cinco dias. E paracetamol se a dor apertar durante o dia. O mais importante: não ficar deitada o dia todo — movimento leve ajuda a lombar. E evita pegar peso, viu? Nada de saco de cimento por uns quinze dias.",
			},
			{
				speaker: "patient",
				text: "Quinze dias sem pegar peso, doutora, lá no trabalho não dá, né? O serviço é físico.",
			},
			{
				speaker: "doctor",
				text: "Então você conversa com o encarregado e pede pra ficar em outra função por esse período — organizar material, fiscalizar, o que der. Se não rolar, pelo menos aprende a dobrar o joelho pra levantar peso, em vez de curvar a coluna. E se a dor não melhorar em dez dias, volta aqui que aí sim a gente pensa em fisioterapia ou exame.",
			},
			{
				speaker: "patient",
				text: "Tá bom, doutora. Obrigada, viu? E a ciclobenzaprina dá sono? Porque eu acordo cedo pra trabalhar.",
			},
			{
				speaker: "doctor",
				text: "Dá um sono sim, é por isso que é à noite. Se mesmo assim você acordar cansada, me avisa que a gente ajusta. Dez dias, então. Qualquer sinal de alarme, não espera. Tchau, Lia.",
			},
		],
		entities: [
			{ category: "medication", value: "ciclobenzaprina" },
			{ category: "medication", value: "paracetamol" },
			{ category: "frequency", value: "um comprimido à noite" },
			{ category: "date", value: "cinco dias" },
			{ category: "date", value: "dez dias" },
		],
	},
];
