// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title CollectiveActionSettler
/// @notice The "other chain" leg of Sealed Collective Action.
///
/// Midnight holds all the private logic: pledges, the hidden threshold, and the
/// zero-knowledge proof that the threshold was reached. THIS contract lives on
/// an EVM chain and does nothing until it is handed a verified reveal from
/// Midnight. It is the public, on-chain consequence of a private coordinated
/// action.
///
/// Trust model for the hackathon demo: a relayer submits the Midnight reveal.
/// The contract binds each settlement to the Midnight `targetCommit`, so a
/// settlement is permanently tied to the exact campaign commitment that was
/// published on Midnight at creation time. In production the `relayer` would be
/// replaced by a verifier contract / light client that checks the Midnight
/// proof on-chain; the interface here is intentionally that shape.
contract CollectiveActionSettler {
    /// The party authorized to relay verified Midnight reveals.
    address public immutable relayer;

    struct Settlement {
        bytes32 targetCommit;   // commitment published on Midnight at creation
        bytes32 revealedTarget; // target hash disclosed by Midnight at reveal
        uint256 settledAt;      // block timestamp of settlement
        bool exists;
    }

    /// targetCommit => settlement. One settlement per Midnight campaign.
    mapping(bytes32 => Settlement) public settlements;

    /// Fired when a coordinated action is settled on this chain. Downstream
    /// systems (payouts, registries, other contracts) react to this.
    event CollectiveActionUnlocked(
        bytes32 indexed targetCommit,
        bytes32 revealedTarget,
        uint256 settledAt
    );

    error NotRelayer();
    error AlreadySettled();
    error EmptyReveal();

    constructor(address _relayer) {
        relayer = _relayer;
    }

    /// @notice Settle a coordinated action whose threshold fired on Midnight.
    /// @param targetCommit   The salted target commitment published on Midnight.
    /// @param revealedTarget The target hash Midnight disclosed at reveal.
    ///
    /// Only the relayer can call this, and only once per campaign. The Midnight
    /// side guarantees this is called ONLY when `unlocked == true`; before the
    /// hidden threshold is reached, no reveal exists to relay, so this chain
    /// learns nothing about the campaign.
    function settle(bytes32 targetCommit, bytes32 revealedTarget) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (settlements[targetCommit].exists) revert AlreadySettled();
        if (revealedTarget == bytes32(0)) revert EmptyReveal();

        settlements[targetCommit] = Settlement({
            targetCommit: targetCommit,
            revealedTarget: revealedTarget,
            settledAt: block.timestamp,
            exists: true
        });

        emit CollectiveActionUnlocked(targetCommit, revealedTarget, block.timestamp);
    }

    /// @notice True once the coordinated action for a campaign has settled.
    function isUnlocked(bytes32 targetCommit) external view returns (bool) {
        return settlements[targetCommit].exists;
    }
}
