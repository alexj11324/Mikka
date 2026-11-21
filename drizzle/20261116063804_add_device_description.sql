-- target: MIKKA_DATABASE_URL

ALTER TABLE devices ADD COLUMN description varchar(500);
