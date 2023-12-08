import { keys } from '../libs/crypto_tools.js'
import { ripemd160 } from '../libs/ripemd160.js'
import { toHex, fromUnicode, fromHex } from '../libs/bytes.js'
import { Tx, Signer } from '../libs/tapscript.js'

function toPublicKey(secret) {
	// Drop the first byte of the pubkey
	return toHex(keys.get_pubkey(secret)).slice(2)
}

const hash = buffer => ripemd160(buffer)

const PREIMAGE_SIZE = 20
const PREIMAGE_SIZE_HEX = PREIMAGE_SIZE * 2

const DELIMITER = '='

const hashId = (identifier, index, value = 0) => {
	// TODO: ensure there's no DELIMITER in identifier, index, or value
	if (index === undefined)
		return `${identifier}${DELIMITER}${value}`
	return `${identifier}_${index}${DELIMITER}${value}`
}

const toCommitmentId = (identifier, index) => {
	if (index === undefined)
		return `${identifier}`
	return `${identifier}_${index}`
}

const parseHashId = hashId => {
	if (!hashId)
		throw Error('hashId is undefined')
	const [commitmentId, value] = hashId.split(DELIMITER)
	return { commitmentId, value }
}

const _preimage = (secret, hashId) =>
	hash(fromUnicode(secret + hashId))

const _hashLock = (secret, hashId) =>
	toHex(hash(_preimage(secret, hashId)))

const preimage = (secret, identifier, index, value) =>
	toHex(_preimage(secret, hashId(identifier, index, value)))

const hashLock = (secret, identifier, index, value) =>
	toHex(hash(_preimage(secret, hashId(identifier, index, value))))


class Actor {
	unlock;
	commit;
	push;

	constructor(unlockWrapper, commitWrapper, pushWrapper) {
		this.unlock = new unlockWrapper(this)
		this.commit = new commitWrapper(this)
		this.push = new pushWrapper(this)
	}


}

export class Player extends Actor {
	#secret;
	hashes = {};
	state;

	constructor(secret, ...wrapper) {
		super(...wrapper)
		this.#secret = secret;
		// TODO: make the seckey private too. Add a sign function instead
		this.seckey = keys.get_seckey(secret)
		this.pubkey = toPublicKey(this.seckey)
		this.hashes.pubkey = this.pubkey
		this.state = state
	}

	//TODO: REMOVE debug code
	print_state() {
		console.log(state)
	}

	hashlock(identifier, index, value) {
		const hash = hashLock(this.#secret, identifier, index, value)
		this.hashes[hashId(identifier, index, value)] = hash
		return hash
	}

	preimage(identifier, index, value) {
		const commitmentId = toCommitmentId(identifier, index)
		this.state.set(commitmentId, value)
		return preimage(this.#secret, identifier, index, value)
	}

	sign(leaf, inputIndex = 0) {
		const tx = leaf.tx.tx()
		const extension = leaf.encodedLockingScript
		return Signer.taproot.sign(this.seckey, tx, inputIndex, { extension }).hex
	}

	computeHashes(hashIds) {
		return hashIds.reduce((result, hashId) => {
			result[hashId] = _hashLock(this.#secret, hashId)
			return result
		}, {})
	}
}

class EquivocationError extends Error {
	constructor(preimageA, preimageB) {
		super(`Equivocation ${preimageA} ${preimageB}`);
		this.name = 'EquivocationError';
	}
}

export class Opponent extends Actor {
	#idToHash;
	#hashToId;
	#preimages = {};
	#commitments = {};
	state

	constructor(hashes, ...wrapper) {
		super(...wrapper)
		this.#idToHash = hashes
		this.#hashToId = Object.keys(hashes).reduce((accu, hashId) => {
			accu[hashes[hashId]] = hashId
			return accu
		}, {})
		this.state = state
	}

	hashlock(identifier, index, value) {
		const id = hashId(identifier, index, value)
		const hash = this.#idToHash[id]
		if (!hash)
			throw `Hash for ${id} is not known`
		return hash
	}

	preimage(identifier, index, value) {
		const id = hashId(identifier, index, value)
		const preimage = this.#preimages[id]
		if (!preimage)
			throw `Preimage of ${id} is not known`
		return preimage
	}

	learnPreimage(preimage) {
		const hash = toHex(ripemd160(fromHex(preimage)))
		const id = this.#hashToId[hash]
		if (!id)
			return console.log('discarding', hash)

		this.#preimages[id] = preimage

		const { commitmentId, value } = parseHashId(id)


		// Check if we know some conflicting preimage
		const prevPreimage = this.#commitments[commitmentId]
		if (!prevPreimage) {
			this.#commitments[commitmentId] = preimage
			this.state.set(commitmentId, value)
			return
		}

		if (preimage != prevPreimage)
			throw new EquivocationError(prevPreimage, preimage)
	}

	processTx(txHex) {
		const tx = Tx.decode(txHex)

		// Read the preimages
		const preimages = tx.vin[0].witness.filter(el => el.length == PREIMAGE_SIZE_HEX)
		preimages.forEach(preimage => this.learnPreimage(preimage))
	}

	get pubkey() {
		return this.#idToHash.pubkey
	}
}



class State {

	#state = {};

	set(commitmentId, value) {
		const value = parseInt(value)
		const prevValue = this.#state[commitmentId]
		if (prevValue !== undefined && prevValue !== value)
			throw Error(`Value of ${commitmentId} is already set to a different value: ${value} in state: ${prevValue}`)
		this.#state[commitmentId] = value
	}

	get_u160(identifier) {
		let result = 0n
		for (let i = 1; i <= 5; i++) {
			const childId = `${identifier}_${6 - i}`
			const value = BigInt(this.get_u32(childId))
			result <<= 32n
			result += value
		}
		return result.toString(16).padStart(40, 0)
	}

	get_u32(identifier) {
		let result = 0
		for (let i = 0; i < 4; i++) {
			const childId = `${identifier}_byte${i}`
			const value = this.get_u8(childId)
			result *= 2 ** 8	// Want to do a left shift here, but JS numbers are weird
			result += value
		}
		return result
	}

	get_u8(identifier) {
		let result = 0
		for (let i = 0; i < 4; i++) {
			const childId = `${identifier}_${3 - i}`
			const value = this.get_u2(childId)
			result <<= 2
			result += value
		}
		return result
	}

	get_u2(identifier) {
		const value = this.#state[identifier]
		if (value === undefined)
			throw Error(`Value of ${identifier} is not known`)
		return value
	}

	get_u1(identifier) {
		const value = this.#state[identifier]
		if (value === undefined)
			throw Error(`Value of ${identifier} is not known`)
		return value
	}
}
