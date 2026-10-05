import { readFileSync } from "node:fs";
import {
	Connection,
	PublicKey,
	TransactionInstruction,
	TransactionMessage,
} from "@solana/web3.js";
import * as squads from "@sqds/multisig";

/** @typedef {{program_id: string, accounts: {pubkey: string, is_signer: boolean, is_writable: boolean}[], data: number[]}} WireInstruction */
/** @typedef {{op: string, rpc_url: string, creator: string, partner: string, create_key: string, index?: number, member?: string, instructions?: WireInstruction[]}} Request */

/** @param {TransactionInstruction} ix */
export function encode(ix) {
	return {
		program_id: ix.programId.toBase58(),
		accounts: ix.keys.map((key) => ({
			pubkey: key.pubkey.toBase58(),
			is_signer: key.isSigner,
			is_writable: key.isWritable,
		})),
		data: [...ix.data],
	};
}

/** @param {WireInstruction} ix */
export function decode(ix) {
	return new TransactionInstruction({
		programId: new PublicKey(ix.program_id),
		keys: ix.accounts.map((key) => ({
			pubkey: new PublicKey(key.pubkey),
			isSigner: key.is_signer,
			isWritable: key.is_writable,
		})),
		data: Buffer.from(ix.data),
	});
}

/** Build instructions only. This bridge never receives or uses private keys.
 * @param {Request} request
 */
export async function build(request) {
	const creator = new PublicKey(request.creator);
	const createKey = new PublicKey(request.create_key);
	const multisigPda = squads.getMultisigPda({ createKey })[0];
	const vaultPda = squads.getVaultPda({ multisigPda, index: 0 })[0];
	const connection = new Connection(request.rpc_url, "confirmed");
	const transactionIndex = BigInt(request.index ?? 1);
	const common = { multisigPda, transactionIndex };
	/** @type {TransactionInstruction[]} */
	let instructions;
	switch (request.op) {
		case "create": {
			const config = await squads.accounts.ProgramConfig.fromAccountAddress(
				connection,
				squads.getProgramConfigPda({})[0],
			);
			instructions = [
				squads.instructions.multisigCreateV2({
					creator,
					createKey,
					multisigPda,
					configAuthority: null,
					threshold: 2,
					timeLock: 0,
					rentCollector: creator,
					treasury: config.treasury,
					members: [creator, new PublicKey(request.partner)].map((key) => ({
						key,
						permissions: squads.types.Permissions.all(),
					})),
				}),
			];
			break;
		}
		case "propose":
			instructions = [
				squads.instructions.vaultTransactionCreate({
					...common,
					creator,
					vaultIndex: 0,
					ephemeralSigners: 0,
					transactionMessage: new TransactionMessage({
						payerKey: vaultPda,
						// Squads stores instructions/account metas, not this blockhash.
						recentBlockhash: PublicKey.default.toBase58(),
						instructions: (request.instructions ?? []).map(decode),
					}),
				}),
				squads.instructions.proposalCreate({ ...common, creator }),
			];
			break;
		case "approve":
			instructions = [
				squads.instructions.proposalApprove({
					...common,
					member: new PublicKey(request.member ?? request.creator),
				}),
			];
			break;
		case "execute": {
			const result = await squads.instructions.vaultTransactionExecute({
				...common,
				connection,
				member: creator,
			});
			if (result.lookupTableAccounts.length)
				throw new Error("This fixture does not use lookup tables");
			instructions = [result.instruction];
			break;
		}
		default:
			throw new Error(`Unknown bridge operation: ${request.op}`);
	}
	return {
		multisig: multisigPda.toBase58(),
		vault: vaultPda.toBase58(),
		program: squads.PROGRAM_ID.toBase58(),
		instructions: instructions.map(encode),
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const request = JSON.parse(readFileSync(0, "utf8"));
	process.stdout.write(JSON.stringify(await build(request)));
}
