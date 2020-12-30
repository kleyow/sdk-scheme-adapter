/**************************************************************************
 *  (C) Copyright ModusBox Inc. 2020 - All rights reserved.               *
 *                                                                        *
 *  This file is made available under the terms of the license agreement  *
 *  specified in the corresponding source code repository.                *
 *                                                                        *
 *  ORIGINAL AUTHOR:                                                      *
 *       Paweł Marzec - pawel.marzec@modusbox.com                         *
 **************************************************************************/

const { Logger } = require('@mojaloop/sdk-standard-components');

function mockLogger(context, keepQuiet) {
    // if keepQuite is undefined then be quiet
    if(keepQuiet || typeof keepQuiet === 'undefined') {
        const log = {
            log: jest.fn(),
            info: jest.fn(),
            error: jest.fn()
        };
        return {
            ...log,
            push: jest.fn(() => log)
        };
    }
    // let be elaborative and dir logging to console
    return new Logger({ context: context, space: 4 });
}

module.exports = mockLogger;
