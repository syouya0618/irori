import { test, expect } from "./fixtures/test"
import { adminClient, cleanupUser, createApprovedUser, uniqueEmail } from "./fixtures/auth"

test("fixture cleanup removes a secondary member's Auth/profile references without deleting the owner's household", async ({}, testInfo) => {
 const owner = await createApprovedUser(`cleanup-owner-${uniqueEmail(testInfo.workerIndex)}`)
 const member = await createApprovedUser(`cleanup-member-${uniqueEmail(testInfo.workerIndex)}`)
 const db = adminClient()
 let householdId: string | undefined, memberRemoved = false
 try {
  const { data: household, error: he } = await db.from("households").insert({ name: "synthetic cleanup household" }).select("id").single()
  if (he) throw he
  householdId = household.id
  for (const [id, role] of [[owner.id, "owner"], [member.id, "member"]] as const) {
   const { error } = await db.from("profiles").update({ household_id: householdId, role }).eq("id", id); if (error) throw error
  }
  const { error: le } = await db.from("baby_logs").insert({ household_id: householdId, logged_by: member.id, log_type: "memo", memo: "synthetic secondary member note" }); if (le) throw le
  const { error: ie } = await db.from("invitations").insert({ household_id: householdId, invited_by: owner.id, accepted_by: member.id, status: "accepted", role: "member", expires_at: new Date(Date.now() + 86400000).toISOString() }); if (ie) throw ie
  await cleanupUser(member.id); memberRemoved = true
  const { data: profile, error: pe } = await db.from("profiles").select("id").eq("id", member.id).maybeSingle(); if (pe) throw pe
  expect(profile).toBeNull()
  const { data: auth, error: authError } = await db.auth.admin.getUserById(member.id)
  expect(authError?.status).toBe(404)
  expect(auth.user).toBeNull()
  const { data: retained, error: re } = await db.from("households").select("id").eq("id", householdId).single(); if (re) throw re
  expect(retained.id).toBe(householdId)
 } finally {
  if (!memberRemoved) await cleanupUser(member.id)
  await cleanupUser(owner.id, householdId)
 }
 const { data: remaining, error } = await db.from("households").select("id").eq("id", householdId!).maybeSingle(); if (error) throw error
 expect(remaining).toBeNull()
})
