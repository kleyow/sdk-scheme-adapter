/**************************************************************************
 *  (C) Copyright ModusBox Inc. 2019 - All rights reserved.               *
 *                                                                        *
 *  This file is made available under the terms of the license agreement  *
 *  specified in the corresponding source code repository.                *
 *                                                                        *
 *  ORIGINAL AUTHOR:                                                      *
 *       Murthy Kakarlamudi - murthy@modusbox.com                         *
 **************************************************************************/

'use strict';

const util = require('util');
const { uuid } = require('uuidv4');
const StateMachine = require('javascript-state-machine');
const { MojaloopRequests } = require('@mojaloop/sdk-standard-components');
const { BackendError } = require('./common');

const transferStateEnum = {
    'WAITING_FOR_PARTY_ACCEPTANCE': 'WAITING_FOR_PARTY_ACCEPTANCE',
    'ERROR_OCCURRED': 'ERROR_OCCURRED',
    'COMPLETED': 'COMPLETED',
};

class OutboundGetPartiesModel {

    constructor(config) {
        this._cache = config.cache;
        this._logger = config.logger;
        this._requestProcessingTimeoutSeconds = config.requestProcessingTimeoutSeconds;
        this._dfspId = config.dfspId;
        this._expirySeconds = config.expirySeconds;
        this._autoAcceptParty = config.autoAcceptParty;

        this._requests = new MojaloopRequests({
            logger: this._logger,
            peerEndpoint: config.peerEndpoint,
            alsEndpoint: config.alsEndpoint,
            dfspId: config.dfspId,
            tls: config.tls,
            jwsSign: config.jwsSign,
            jwsSignPutParties: config.jwsSignPutParties,
            jwsSigningKey: config.jwsSigningKey,
            wso2Auth: config.wso2Auth
        });
    }

    /**
     * Initializes the request to pay model
     *
     * @param data {object} - The inbound API POST /requestToPay request body
     */
    async initialize(data) {
        this.data = data;
        //idType, idValue, idSubValue

        //Set fsp id in the from section of the request that gets sent back in the response
        //this.data.from.fspId = this._dfspId;

        this._initStateMachine(this.data.currentState);
    }

    /**
     * Initializes the internal state machine object
     */
    _initStateMachine (initState) {
        this.stateMachine = new StateMachine({
            init: initState,
            transitions: [
                { name: 'resolveParty', from: 'start', to: 'suceeded' },
                { name: 'error', from: '*', to: 'errored' },
            ],
            methods: {
                onTransition: this._handleTransition.bind(this),
                onAfterTransition: this._afterTransition.bind(this),
                onPendingTransition: (transition, from, to) => {
                    // allow transitions to 'error' state while other transitions are in progress
                    if(transition !== 'error') {
                        throw new Error(`Transition requested while another transition is in progress: ${transition} from: ${from} to: ${to}`);
                    }
                }
            }
        });

        return this.stateMachine[initState];
    }

    /**
     * Handles state machine transitions
     */
    async _handleTransition(lifecycle, ...args) {
        this._logger.log(`Parties ${this.data.idType} ${this.data.idValue} is transitioning from ${lifecycle.from} to ${lifecycle.to} in response to ${lifecycle.transition}`);

        switch(lifecycle.transition) {
            case 'init':
                // init, just allow the fsm to start
                return;

            case 'resolveParty':
                // resolve the party
                return this._resolveParty();

            case 'error':
                this._logger.log(`State machine is erroring with error: ${util.inspect(args)}`);
                this.data.lastError = args[0] || new Error('unspecified error');
                break;

            default:
                throw new Error(`Unhandled state transition for transfer ${this.data.transferId}: ${util.inspect(args)}`);
        }
    }

    /**
     * Updates the internal state representation to reflect that of the state machine itself
     */
    _afterTransition() {
        this._logger.log(`State machine transitioned: ${this.data.currentState} -> ${this.stateMachine.state}`);
        this.data.currentState = this.stateMachine.state;
    }

    /**
     * Resolves the party.
     * Starts the party resolution process by sending a GET /parties request to the switch;
     * then waits for a notification from the cache that the party has been resolved.
     */
    async _resolveParty() {
        // eslint-disable-next-line no-async-promise-executor
        return new Promise(async (resolve, reject) => {
            // listen for resolution events on the party idType and idValue
            const partyKey = `${this.data.idType}_${this.data.idValue}`
              + (this.data.idSubValue ? `_${this.data.idSubValue}` : '');

            // hook up a subscriber to handle response messages
            const subId = await this._cache.subscribe(partyKey, (cn, msg, subId) => {
                try {
                    let partyResp = JSON.parse(msg);

                    if(partyResp.errorInformation) {
                        // this is an error response to our GET /parties request
                        const err = new BackendError(`Got an error response resolving party: ${util.inspect(partyResp)}`, 500);
                        err.mojaloopError = partyResp;

                        // cancel the timeout handler
                        clearTimeout(timeout);
                        return reject(err);
                    }

                    if(!partyResp.party) {
                        // we should never get a non-error response without a party, but just in case...
                        // cancel the timeout handler
                        clearTimeout(timeout);
                        return reject(new Error(`Resolved party has no party object: ${util.inspect(partyResp)}`));
                    }

                    let party = partyResp.party;

                    // cancel the timeout handler
                    clearTimeout(timeout);

                    this._logger.push({ party }).log('Party resolved');

                    // stop listening for party resolution messages
                    // no need to await for the unsubscribe to complete.
                    // we dont really care if the unsubscribe fails but we should log it regardless
                    this._cache.unsubscribe(partyKey, subId).catch(e => {
                        this._logger.log(`Error unsubscribing (in callback) ${partyKey} ${subId}: ${e.stack || util.inspect(e)}`);
                    });

                    // check we got the right party and info we need
                    if(party.partyIdInfo.partyIdType !== this.data.idType) {
                        const err = new Error(`Expecting resolved party party IdType to be ${this.data.to.idType} but got ${party.partyIdInfo.partyIdType}`);
                        return reject(err);
                    }

                    if(party.partyIdInfo.partyIdentifier !== this.data.idValue) {
                        const err = new Error(`Expecting resolved party party identifier to be ${this.data.to.idValue} but got ${party.partyIdInfo.partyIdentifier}`);
                        return reject(err);
                    }

                    if(party.partyIdInfo.partySubIdOrType !== this.data.idSubValue) {
                        const err = new Error(`Expecting resolved party party subTypeId to be ${this.data.to.idSubValue} but got ${party.partyIdInfo.partySubIdOrType}`);
                        return reject(err);
                    }

                    if(!party.partyIdInfo.fspId) {
                        const err = new Error(`Expecting resolved party party to have an FSPID: ${util.inspect(party.partyIdInfo)}`);
                        return reject(err);
                    }

                    // now we got the party, add the details to our data so we can use it
                    // in the quote request
                    //this.data.to.fspId = party.partyIdInfo.fspId;

                    if(party.personalInfo) {
                        if(party.personalInfo.complexName) {
                            this.data.firstName = party.personalInfo.complexName.firstName;
                            this.data.middleName = party.personalInfo.complexName.middleName;
                            this.data.lastName = party.personalInfo.complexName.lastName;
                        }
                        this.data.dateOfBirth = party.personalInfo.dateOfBirth;
                    }

                    return resolve(party);
                }
                catch(err) {
                    return reject(err);
                }
            });

            // set up a timeout for the resolution
            const timeout = setTimeout(() => {
                const err = new BackendError(`Timeout resolving party for transfer ${this.data.transferId}`, 504);

                // we dont really care if the unsubscribe fails but we should log it regardless
                this._cache.unsubscribe(partyKey, subId).catch(e => {
                    this._logger.log(`Error unsubscribing (in timeout handler) ${partyKey} ${subId}: ${e.stack || util.inspect(e)}`);
                });

                return reject(err);
            }, this._requestProcessingTimeoutSeconds * 1000);

            // now we have a timeout handler and a cache subscriber hooked up we can fire off
            // a GET /parties request to the switch
            try {
                const res = await this._requests.getParties(this.data.idType, this.data.idValue,
                    this.data.idSubValue);
                this._logger.push({ peer: res }).log('Party lookup sent to peer');
            }
            catch(err) {
                // cancel the timout and unsubscribe before rejecting the promise
                clearTimeout(timeout);

                // we dont really care if the unsubscribe fails but we should log it regardless
                this._cache.unsubscribe(partyKey, subId).catch(e => {
                    this._logger.log(`Error unsubscribing ${partyKey} ${subId}: ${e.stack || util.inspect(e)}`);
                });

                return reject(err);
            }
        });
    }

    /**
     * Returns a promise that resolves when the state machine has reached a terminal state
     */
    async run() {
        try {
            // run transitions based on incoming state
            switch(this.data.currentState) {
                case 'start':
                    // next transition is to resolveParty
                    await this.stateMachine.resolveParty();
                    this._logger.log(`Party resolved for transfer ${this.data.transferId}`);
                    await this._save();
                    return this.getResponse();

                case 'succeeded':
                    // all steps complete so return
                    this._logger.log('Transaction Request completed successfully');
                    await this._save();
                    return this.getResponse();

                case 'errored':
                    // stopped in errored state
                    this._logger.log('State machine in errored state');
                    return;
            }

            // now call ourslves recursively to deal with the next transition
            this._logger.log(`Transfer model state machine transition completed in state: ${this.stateMachine.state}. Recusring to handle next transition.`);
            return this.run();
        }
        catch(err) {
            this._logger.log(`Error running transfer model: ${util.inspect(err)}`);

            // as this function is recursive, we dont want to error the state machine multiple times
            if(this.data.currentState !== 'errored') {
                // err should not have a transferState property here!
                if(err.transferState) {
                    this._logger.log(`State machine is broken: ${util.inspect(err)}`);
                }
                // transition to errored state
                await this.stateMachine.error(err);

                // avoid circular ref between transferState.lastError and err
                err.transferState = JSON.parse(JSON.stringify(this.getResponse()));
            }
            throw err;
        }
    }

    /**
     * Returns an object representing the final state of the transfer suitable for the outbound API
     *
     * @returns {object} - Response representing the result of the transfer process
     */
    getResponse() {
        // we want to project some of our internal state into a more useful
        // representation to return to the SDK API consumer
        let resp = { ...this.data };

        switch(this.data.currentState) {
            case 'succeeded':
                resp.currentState = transferStateEnum.COMPLETED;
                break;

            case 'errored':
                resp.currentState = transferStateEnum.ERROR_OCCURRED;
                break;

            default:
                this._logger.log(`Transaction Request model response being returned from an unexpected state: ${this.data.currentState}. Returning ERROR_OCCURRED state`);
                resp.currentState = transferStateEnum.ERROR_OCCURRED;
                break;
        }

        return resp;
    }

    /**
     * Persists the model state to cache for reinstantiation at a later point
     */
    async _save() {
        try {
            this.data.currentState = this.stateMachine.state;
            //const res = await this._cache.set(`txnReqModel_${this.data.transactionRequestId}`, this.data);
            this._logger.push({ res }).log('Persisted transaction request model in cache');
        }
        catch(err) {
            this._logger.push({ err }).log('Error saving transfer model');
            throw err;
        }
    }
}

module.exports = OutboundGetPartiesModel;
