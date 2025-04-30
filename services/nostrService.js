const { SimplePool } = require('nostr-tools/pool');
const WebSocket = require('ws');
const { useWebSocketImplementation } = require('nostr-tools/pool');

// Configure WebSocket for Node.js environment
useWebSocketImplementation(WebSocket);

class NostrService {
  constructor() {
    this.pool = null;
    this.defaultRelays = process.env.DEFAULT_RELAYS 
      ? process.env.DEFAULT_RELAYS.split(',') 
      : ['wss://relay.damus.io', 'wss://relay.nostr.band', 'wss://nos.lol'];
    this.timeout = parseInt(process.env.RELAY_TIMEOUT || '3000');
  }

  initialize() {
    if (this.pool) {
      this.pool.close(this.defaultRelays);
    }
    this.pool = new SimplePool();
    console.log(`Initialized Nostr pool with relays: ${this.defaultRelays.join(', ')}`);
  }

  /**
   * Fetch a Nostr event by its ID
   * @param {string} eventId - The event ID in hex format
   * @param {Array<string>} relayHints - Optional relay hints
   * @returns {Promise<Object>} The event object
   */
  async getEvent(eventId, relayHints = []) {
    if (!this.pool) {
      this.initialize();
    }

    // Combine default relays with relay hints
    const relays = [...new Set([...this.defaultRelays, ...relayHints])];
    
    try {
      console.log(`Fetching event ${eventId} from relays:`, relays);
      
      const event = await this.pool.get(
        relays,
        {
          ids: [eventId]
        },
        {
          timeout: this.timeout
        }
      );

      if (!event) {
        console.log(`Event ${eventId} not found`);
        return null;
      }

      // If this is a note, also get the author's profile
      if (event.kind === 1) {
        try {
          const authorProfile = await this.getProfile(event.pubkey, relayHints);
          if (authorProfile) {
            // Add author profile information to the event
            event.author = authorProfile;
          }
        } catch (error) {
          console.warn(`Could not fetch author profile for event ${eventId}:`, error.message);
        }
      }

      return event;
    } catch (error) {
      console.error(`Error fetching event ${eventId}:`, error);
      throw error;
    }
  }

  /**
   * Fetch a Nostr profile by pubkey
   * @param {string} pubkey - The public key in hex format
   * @param {Array<string>} relayHints - Optional relay hints
   * @returns {Promise<Object>} The profile object
   */
  async getProfile(pubkey, relayHints = []) {
    if (!this.pool) {
      this.initialize();
    }

    // Combine default relays with relay hints
    const relays = [...new Set([...this.defaultRelays, ...relayHints])];
    
    try {
      console.log(`Fetching profile ${pubkey} from relays:`, relays);
      
      // Get the most recent kind 0 event (metadata) for this pubkey
      const profileEvent = await this.pool.get(
        relays,
        {
          kinds: [0],
          authors: [pubkey]
        },
        {
          timeout: this.timeout
        }
      );

      if (!profileEvent) {
        console.log(`Profile for ${pubkey} not found`);
        return null;
      }

      let profileData;
      try {
        profileData = JSON.parse(profileEvent.content);
      } catch (e) {
        console.error(`Error parsing profile content for ${pubkey}:`, e);
        profileData = {}; // Default to empty object if parsing fails
      }

      // Return both the raw event and the parsed profile data
      return {
        ...profileEvent,
        profile: profileData
      };
    } catch (error) {
      console.error(`Error fetching profile ${pubkey}:`, error);
      throw error;
    }
  }

  /**
   * Clean up resources when shutting down
   */
  close() {
    if (this.pool) {
      this.pool.close(this.defaultRelays);
      this.pool = null;
    }
  }
}

module.exports = new NostrService();