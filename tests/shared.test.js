import { describe, it, expect } from 'vitest';
import { getAuth, orgPk, userSk, json } from '../backend/shared.js';

describe('shared utilities', () => {
    it('getAuth returns claims when valid', () => {
        const event = {
            requestContext: {
                authorizer: {
                    jwt: {
                        claims: {
                            'custom:orgId': 'orga',
                            'sub': 'u1'
                        }
                    }
                }
            }
        };
        expect(getAuth(event)).toEqual({ orgId: 'orga', userId: 'u1' });
    });

    it('getAuth returns null for missing or invalid claims', () => {
        expect(getAuth({})).toBeNull();
        expect(getAuth({ requestContext: { authorizer: { jwt: { claims: {} } } } })).toBeNull();
        expect(getAuth({ requestContext: { authorizer: { jwt: { claims: { 'custom:orgId': '', 'sub': 'u1' } } } } })).toBeNull();
        expect(getAuth({ requestContext: { authorizer: { jwt: { claims: { 'custom:orgId': 'invalid org', 'sub': 'u1' } } } } })).toBeNull();
    });

    it('orgPk and userSk generate correct keys', () => {
        expect(orgPk('orga')).toBe('ORG#orga');
        expect(userSk('u1')).toBe('USER#u1');
    });

    it('json formats correctly', () => {
        expect(json(200, { ok: true })).toEqual({
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ok: true })
        });
    });
});
