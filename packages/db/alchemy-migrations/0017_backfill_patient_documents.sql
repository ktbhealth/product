-- Move the identifier columns of `patients` into `patient_documents`,
-- one row per non-empty value. CPF and CNS are Brazilian documents; the
-- issuing country of a passport was never recorded, so it stays NULL.
-- Runs once, between the table being created and the columns dropped.
INSERT INTO `patient_documents` (`patient_id`, `type`, `country`, `number`)
SELECT `id`, 'cpf', 'BR', `cpf` FROM `patients` WHERE `cpf` IS NOT NULL AND `cpf` <> '';
--> statement-breakpoint
INSERT INTO `patient_documents` (`patient_id`, `type`, `country`, `number`)
SELECT `id`, 'cns', 'BR', `cns` FROM `patients` WHERE `cns` IS NOT NULL AND `cns` <> '';
--> statement-breakpoint
INSERT INTO `patient_documents` (`patient_id`, `type`, `country`, `number`)
SELECT `id`, 'passport', NULL, `passport` FROM `patients` WHERE `passport` IS NOT NULL AND `passport` <> '';
