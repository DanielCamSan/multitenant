module.exports = {
    getSubscriptions: getSubscriptions ,
    createRoute: createRoute,
    deleteRoute: deleteRoute ,
    createSMInstance: createSMInstance,
    getSMInstance: getSMInstance,
    deleteSMInstance: deleteSMInstance
};

const cfenv = require('cfenv');
const appEnv = cfenv.getAppEnv();

const core = require('@sap-cloud-sdk/core');

const axios = require('axios');
const qs = require('qs');

const crypto = require('crypto');
const uuid = require('uuid');

async function getSubscriptions(registry) {
    try {
        // get access token
        let options = {
            method: 'POST',
            url: registry.url + '/oauth/token?grant_type=client_credentials&response_type=token',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(registry.clientid + ':' + registry.clientsecret).toString('base64')
            }
        };
        let res = await axios(options);
        try {
            // get subscriptions
            let options1 = {
                method: 'GET',
                url: registry.saas_registry_url + '/saas-manager/v1/application/subscriptions',
                headers: {
                    'Authorization': 'Bearer ' + res.data.access_token
                }
            };
            let res1 = await axios(options1);
            return res1.data;
        } catch (err) {
            console.log(err.stack);
            return err.message;
        }
    } catch (err) {
        console.log(err.stack);
        return err.message;
    }
};

async function getCFInfo(appname) {
    try {
        // get app GUID
        let res1 = await core.executeHttpRequest({ destinationName: 'abap-cfapi'}, {
            method: 'GET',
            url: '/v3/apps?organization_guids=' + appEnv.app.organization_id + '&space_guids=' + appEnv.app.space_id + '&names=' + appname
        });
        // get domain GUID
        let res2 = await core.executeHttpRequest({ destinationName: 'abap-cfapi'}, {
            method: 'GET',
            url: '/v3/domains?names=' + /\.(.*)/gm.exec(appEnv.app.application_uris[0])[1]
        });
        let results = {
            'app_id': res1.data.resources[0].guid,
            'domain_id': res2.data.resources[0].guid
        };
        return results;
    } catch (err) {
        console.log(err.stack);
        return err.message;
    }
};

async function createRoute(tenantHost, appname) {
    getCFInfo(appname).then(
        async function (CFInfo) {
            try {
                // create route
                let res1 = await core.executeHttpRequest({ destinationName: 'abap-cfapi'}, {
                    method: 'POST',
                    url: '/v3/routes',
                    data: {
                        'host': tenantHost,
                        'relationships': {
                            'space': {
                                'data': {
                                    'guid': appEnv.app.space_id
                                }
                            },
                            'domain': {
                                'data': {
                                    'guid': CFInfo.domain_id
                                }
                            }
                        }
                    },
                });
                // map route to app
                let res2 = await core.executeHttpRequest({ destinationName: 'abap-cfapi'}, {
                    method: 'POST',
                    url: '/v3/routes/' + res1.data.guid + '/destinations',
                    data: {
                        'destinations': [{
                            'app': {
                                'guid': CFInfo.app_id
                            }
                        }]
                    },
                });
                console.log('Route created for ' + tenantHost);
                return res2.data;
            } catch (err) {
                console.log(err.stack);
                return err.message;
            }
        },
        function (err) {
            console.log(err.stack);
            return err.message;
        });
};

async function deleteRoute(tenantHost, appname) {
    getCFInfo(appname).then(
        async function (CFInfo) {
            try {
                // get route id
                let res1 = await core.executeHttpRequest({ destinationName: 'abap-cfapi'}, {
                    method: 'GET',
                    url: '/v3/apps/' + CFInfo.app_id + '/routes?hosts=' + tenantHost
                });
                if (res1.data.pagination.total_results === 1) {
                    try {
                        // delete route
                        let res2 = await core.executeHttpRequest({ destinationName: 'abap-cfapi'}, {
                            method: 'DELETE',
                            url: '/v3/routes/' + res1.data.resources[0].guid
                        });
                        console.log('Route deleted for ' + tenantHost);
                        return res2.data;
                    } catch (err) {
                        console.log(err.stack);
                        return err.message;
                    }
                } else {
                    let errmsg = { 'error': 'Route not found' };
                    console.log(errmsg);
                    return errmsg;
                }
            } catch (err) {
                console.log(err.stack);
                return err.message;
            }
        },
        function (err) {
            console.log(err.stack);
            return err.message;
        });
};

async function getSMToken(sm) {
    try {
        // get access token
        let options = {
            method: 'POST',
            url: sm.url + '/oauth/token?grant_type=client_credentials&response_type=token',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(sm.clientid + ':' + sm.clientsecret).toString('base64')
            }
        };
        let res = await axios(options);
        return 'Bearer ' + res.data.access_token;
    } catch (err) {
        console.log(err.stack);
        return err.message;
    }
};

async function getSMInfo(sm, tenantId) {
    try {
        let smToken = await getSMToken(sm);
        // get service offering id
        let options1 = {
            method: 'GET',
            url: sm.sm_url + "/v1/service_offerings?fieldQuery=catalog_name eq 'hana'",
            headers: {
                'Authorization': smToken
            }
        };
        let res1 = await axios(options1);
        if (res1.data.num_items === 1) {
            // get service plan id
            let options2 = {
                method: 'GET',
                url: sm.sm_url + "/v1/service_plans?fieldQuery=catalog_name eq 'hdi-shared' and service_offering_id eq '" + res1.data.items[0].id + "'",
                headers: {
                    'Authorization': smToken
                }
            };
            let res2 = await axios(options2);
            if (res2.data.num_items === 1) {
                let results = {
                    'accessToken': smToken,
                    'serviceOfferingId': res1.data.items[0].id,
                    'servicePlanId': res2.data.items[0].id,
                    'instanceName': crypto.createHash('sha256').update(res2.data.items[0].id + '_' + tenantId).digest('base64')
                };
                return results;
            } else {
                let errmsg = { 'error': 'Service plan hdi-shared not found' };
                console.log(errmsg);
                return errmsg;
            }
        } else {
            let errmsg = { 'error': 'Service offering hana not found' };
            console.log(errmsg);
            return errmsg;
        }
    } catch (err) {
        console.log(err.stack);
        return err.message;
    }
};

async function createSMInstance(sm, tenantId) {
    try {
        let smInfo = await getSMInfo(sm, tenantId);
        // create service instance
        let options1 = {
            method: 'POST',
            url: sm.sm_url + '/v1/service_instances?async=false',
            data: {
                'name': smInfo.instanceName,
                'service_plan_id': smInfo.servicePlanId,
                'labels': {
                    'tenant_id': ['hdi_' + tenantId]
                }
            },
            headers: {
                'Authorization': smInfo.accessToken
            }
        };
        let res1 = await axios(options1);
        // create service binding
        let options2 = {
            method: 'POST',
            url: sm.sm_url + '/v1/service_bindings?async=false',
            data: {
                'name': uuid.v4(),
                'service_instance_id': res1.data.id,
                'labels': {
                    'tenant_id': ['hdi_' + tenantId],
                    'service_plan_id': [smInfo.servicePlanId]
                }
            },
            headers: {
                'Authorization': smInfo.accessToken
            }
        };
        let res2 = await axios(options2);
        if (res2.data.hasOwnProperty('id') && res2.data.hasOwnProperty('credentials')) {
            let payload = { 'id': res2.data.id, 'credentials': res2.data.credentials, 'status': 'CREATION_SUCCEEDED' };
            // deploy DB artefacts
            let options3 = {
                method: 'POST',
                data: payload,
                url: process.env.db_api_url + '/v1/deploy/to/instance',
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(process.env.db_api_user + ':' + process.env.db_api_password).toString('base64'),
                    'Content-Type': 'application/json'
                }
            };
            let res3 = await axios(options3);
            console.log('Database created for ' + tenantId);
            return res3.data;
        } else {
            let errmsg = { 'error': 'Invalid service binding' };
            console.log(errmsg, res2);
            return errmsg;
        }
    } catch (err) {
        console.log(err.stack);
        return err.message;
    }
};

async function getSMInstance(sm, tenantId) {
    try {
        let smToken = await getSMToken(sm);
        // get service binding details
        let options1 = {
            method: 'GET',
            url: sm.sm_url + "/v1/service_bindings?labelQuery=tenant_id eq 'hdi_" + tenantId + "'",
            headers: {
                'Authorization': smToken
            }
        };
        let res1 = await axios(options1);
        if (res1.data.num_items === 1) {
            return res1.data.items[0];
        } else {
            let errmsg = { 'error': 'Service binding not found for tenant ' + tenantId };
            console.log(errmsg);
            return errmsg;
        }
    } catch (err) {
        console.log(err.stack);
        return err.message;
    }
};

async function deleteSMInstance(sm, tenantId) {
    try {
        let smInfo = await getSMInfo(sm, tenantId);
        // get service binding and service instance ids
        let options1 = {
            method: 'GET',
            url: sm.sm_url + "/v1/service_bindings?labelQuery=tenant_id eq 'hdi_" + tenantId + "'",
            headers: {
                'Authorization': smInfo.accessToken
            }
        };
        let res1 = await axios(options1);
        if (res1.data.num_items === 1) {
            // delete service binding
            let options2 = {
                method: 'DELETE',
                url: sm.sm_url + '/v1/service_bindings/' + res1.data.items[0].id,
                headers: {
                    'Authorization': smInfo.accessToken
                }
            };
            let res2 = await axios(options2);
            // delete service instance
            let options3 = {
                method: 'DELETE',
                url: sm.sm_url + '/v1/service_instances/' + res1.data.items[0].service_instance_id,
                headers: {
                    'Authorization': smInfo.accessToken
                }
            };
            let res3 = await axios(options3);
            console.log('Database deleted for ' + tenantId);
            return res3.data;
        } else {
            let errmsg = { 'error': 'Service binding not found for tenant ' + tenantId };
            console.log(errmsg);
            return errmsg;
        }
    } catch (err) {
        console.log(err.stack);
        return err.message;
    }
};
