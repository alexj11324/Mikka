import type { Pool } from 'pg'

/** Broad instrumentation of disposable fixture databases only. This is not a
 * migration or a claim that production dependency coverage is complete. */
export async function instrumentFixtureAuthority(database: Pool) {
  await database.query(`CREATE TABLE run_authority_version (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),source uuid NOT NULL DEFAULT gen_random_uuid(),revision bigint NOT NULL DEFAULT 0);
    INSERT INTO run_authority_version DEFAULT VALUES;
    CREATE FUNCTION fixture_authority_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE run_authority_version SET revision=revision+1 WHERE singleton=true;
      RETURN NULL;
    END $$`)
  const {rows}=await database.query<{tablename:string}>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'run_authority_version' ORDER BY tablename`)
  for(const {tablename} of rows) {
    const quoted='"'+tablename.replaceAll('"','""')+'"'
    await database.query(`CREATE TRIGGER fixture_authority_changed AFTER INSERT OR UPDATE OR DELETE ON ${quoted} FOR EACH ROW EXECUTE FUNCTION fixture_authority_changed()`)
  }
}
