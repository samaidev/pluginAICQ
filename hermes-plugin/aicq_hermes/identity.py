"""
AICQ Identity Manager — Ed25519 signing + X25519 key exchange.

Handles key generation, storage, and loading for AICQ agent identities.
Keys are persisted in the data directory as JSON files.

NOTE: X25519 encryption keys are generated and stored but E2EE message
encryption is NOT YET IMPLEMENTED. Keys are reserved for future use.
Messages are currently sent in plaintext over the server relay.
"""

import json
import os
from typing import Optional

from nacl.signing import SigningKey, VerifyKey
from nacl.public import PrivateKey, PublicKey
from nacl.encoding import HexEncoder


class IdentityManager:
    """Manages AICQ agent identity (Ed25519 signing + X25519 encryption keys)."""

    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
        self._agents: dict = {}  # agent_id -> {signing_key, encrypt_key, ...}

    def _identity_path(self, agent_id: str) -> str:
        return os.path.join(self.data_dir, f"identity_{agent_id}.json")

    def create_agent(self, agent_id: str, agent_name: str = "Hermes AICQ Agent") -> dict:
        """Create a new agent identity with Ed25519 + X25519 key pairs."""
        if agent_id in self._agents:
            return self._agents[agent_id]

        # Generate Ed25519 signing key
        signing_key = SigningKey.generate()
        verify_key = signing_key.verify_key

        # Generate X25519 encryption key
        encrypt_private = PrivateKey.generate()
        encrypt_public = encrypt_private.public_key

        agent = {
            "agent_id": agent_id,
            "agent_name": agent_name,
            "signing_public_key": verify_key.encode(encoder=HexEncoder).decode(),
            "signing_secret_key": signing_key.encode(encoder=HexEncoder).decode(),
            "encrypt_public_key": encrypt_public.encode(encoder=HexEncoder).decode(),
            "encrypt_secret_key": encrypt_private.encode(encoder=HexEncoder).decode(),
        }

        # Persist to disk
        with open(self._identity_path(agent_id), "w") as f:
            json.dump(agent, f, indent=2)

        self._agents[agent_id] = agent
        return agent

    def load_agent(self, agent_id: str) -> Optional[dict]:
        """Load an existing agent identity from disk or cache."""
        if agent_id in self._agents:
            return self._agents[agent_id]

        path = self._identity_path(agent_id)
        if not os.path.exists(path):
            return None

        with open(path, "r") as f:
            agent = json.load(f)

        self._agents[agent_id] = agent
        return agent

    def get_or_create(self, agent_id: str, agent_name: str = "Hermes AICQ Agent") -> dict:
        """Load existing identity or create a new one."""
        existing = self.load_agent(agent_id)
        if existing:
            return existing
        return self.create_agent(agent_id, agent_name)

    def get_signing_key(self, agent_id: str) -> Optional[SigningKey]:
        agent = self.load_agent(agent_id)
        if not agent:
            return None
        return SigningKey(agent["signing_secret_key"], encoder=HexEncoder)

    def get_verify_key(self, agent_id: str) -> Optional[VerifyKey]:
        agent = self.load_agent(agent_id)
        if not agent:
            return None
        return VerifyKey(agent["signing_public_key"], encoder=HexEncoder)

    def get_encrypt_private(self, agent_id: str) -> Optional[PrivateKey]:
        agent = self.load_agent(agent_id)
        if not agent:
            return None
        return PrivateKey(agent["encrypt_secret_key"], encoder=HexEncoder)

    def get_encrypt_public(self, agent_id: str) -> Optional[PublicKey]:
        agent = self.load_agent(agent_id)
        if not agent:
            return None
        return PublicKey(agent["encrypt_public_key"], encoder=HexEncoder)

    # NOTE: E2EE is NOT YET IMPLEMENTED. The following methods are
    # reserved for future client-side encryption. Currently messages are
    # sent in plaintext. To implement E2EE:
    #   1. Exchange X25519 public keys with friends via handshake
    #   2. Derive shared secrets using X25519 DH
    #   3. Encrypt message content with XSalsa20-Poly1305 (NaCl Box)
    #   4. Send encrypted payload in the 'payload.ciphertext' field
    #   5. Decrypt incoming relay messages using the shared secret

    def sign_message(self, agent_id: str, message: bytes) -> Optional[bytes]:
        """Sign a message with the agent's Ed25519 signing key."""
        sk = self.get_signing_key(agent_id)
        if not sk:
            return None
        return sk.sign(message).signature

    def list_agents(self) -> list[str]:
        """List all agent IDs that have identity files."""
        agents = []
        for fname in os.listdir(self.data_dir):
            if fname.startswith("identity_") and fname.endswith(".json"):
                agent_id = fname[len("identity_"):-len(".json")]
                agents.append(agent_id)
        return agents
